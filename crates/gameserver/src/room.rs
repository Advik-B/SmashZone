//! One room = one tokio task running the authoritative sim at 60 Hz.
//! Rooms are independent, so they parallelize across cores for free.

use crate::AppState;
use protocol::{
    encode, ClientMsg, NetPickup, NetPlayer, NetProjectile, Phase, PlayerMeta, ServerMsg,
    SnapshotMsg, player_flags,
};
use rand::Rng;
use sim::arena::Arena;
use sim::constants::consts;
use sim::types::{powerup, PlayerId, PlayerInput, SimEvent};
use sim::GameSim;
use std::collections::{BTreeMap, VecDeque};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};

pub struct JoinAck {
    pub id: PlayerId,
    /// Connection generation; commands carrying a stale epoch (from a socket
    /// that a reconnect superseded) are ignored by the room.
    pub epoch: u32,
    pub out_rx: mpsc::UnboundedReceiver<Vec<u8>>,
}

pub enum RoomCmd {
    Join {
        name: String,
        /// Present when the client is trying to rejoin an existing slot.
        token: Option<String>,
        resp: oneshot::Sender<Result<JoinAck, String>>,
    },
    Msg {
        id: PlayerId,
        epoch: u32,
        msg: ClientMsg,
    },
    Leave {
        id: PlayerId,
        epoch: u32,
    },
    /// Server is shutting down: tell clients to rejoin, then stop the task.
    Shutdown,
}

pub type RoomHandle = mpsc::UnboundedSender<RoomCmd>;

struct RoomPlayer {
    meta: PlayerMeta,
    tx: mpsc::UnboundedSender<Vec<u8>>,
    inputs: VecDeque<protocol::InputMsg>,
    last_input: PlayerInput,
    last_seq: u16,
    /// Ticks since the last input arrived (stale-input safety).
    starved: u16,
    score: u8,
    /// Participating in the current round (spawned at round start).
    in_round: bool,
    /// Session token for reconnecting into this slot.
    token: String,
    /// False while the socket is dropped but the slot is held for a rejoin.
    connected: bool,
    /// Connection generation, bumped on every (re)connect.
    epoch: u32,
    /// Ticks spent disconnected (for grace-window expiry).
    gone_ticks: u32,
}

/// If a client stops sending inputs for this long (throttled tab, hiccup),
/// stop replaying their last held input so they don't walk off the world.
const INPUT_STALE_TICKS: u16 = 30;

/// Max room commands processed per tick, so a command burst can't starve the
/// 60 Hz sim loop.
const CMD_DRAIN_CAP: u32 = 512;

/// Generate a random session token (16 hex chars) for reconnect.
fn gen_token() -> String {
    format!("{:016x}", rand::rng().random::<u64>())
}

/// Strip control characters and clamp a player-supplied name to a safe length.
/// The client escapes names before rendering; this is defense in depth so
/// control chars (NUL, newlines) never reach clients in the first place.
fn sanitize_name(name: &str) -> String {
    let clean: String = name
        .chars()
        .filter(|c| !c.is_control())
        .take(16)
        .collect();
    let clean = clean.trim();
    if clean.is_empty() {
        "Player".to_string()
    } else {
        clean.to_string()
    }
}

enum RoomPhase {
    Lobby,
    Countdown { round: u8, start_at: u32 },
    Playing { round: u8, started_at: u32 },
    RoundEnd { winner: Option<PlayerId>, until: u32 },
    MatchEnd,
}

struct Room {
    code: String,
    sim: GameSim,
    players: BTreeMap<PlayerId, RoomPlayer>,
    phase: RoomPhase,
    tick: u32,
    pending_events: Vec<SimEvent>,
    /// Ticks the room has been empty (for cleanup).
    empty_ticks: u32,
}

impl Room {
    fn host(&self) -> Option<PlayerId> {
        self.players.keys().next().copied()
    }

    fn phase_msg(&self) -> Phase {
        match &self.phase {
            RoomPhase::Lobby => Phase::Lobby {
                host: self.host().unwrap_or(0),
            },
            RoomPhase::Countdown { round, start_at } => Phase::Countdown {
                round: *round,
                start_tick: *start_at,
            },
            RoomPhase::Playing { round, started_at } => Phase::Playing {
                round: *round,
                round_start_tick: *started_at,
            },
            RoomPhase::RoundEnd { winner, .. } => Phase::RoundEnd {
                winner: *winner,
                scores: self.scores(),
            },
            RoomPhase::MatchEnd => {
                let scores = self.scores();
                let winner = scores
                    .iter()
                    .max_by_key(|(_, s)| *s)
                    .map(|(id, _)| *id)
                    .unwrap_or(0);
                Phase::MatchEnd { winner, scores }
            }
        }
    }

    fn scores(&self) -> Vec<(PlayerId, u8)> {
        self.players.iter().map(|(&id, p)| (id, p.score)).collect()
    }

    fn broadcast(&self, msg: &ServerMsg) {
        let bytes = encode(msg);
        for p in self.players.values() {
            let _ = p.tx.send(bytes.clone());
        }
    }

    fn send_phase(&self) {
        tracing::info!("room {}: phase -> {:?} at tick {}", self.code, self.phase_msg(), self.tick);
        self.broadcast(&ServerMsg::PhaseChange {
            phase: self.phase_msg(),
            tick: self.tick,
        });
    }

    fn movement_allowed(&self) -> bool {
        matches!(self.phase, RoomPhase::Lobby | RoomPhase::Playing { .. })
    }

    fn random_spawn(&self) -> [f32; 3] {
        // Deterministic-ish scatter by tick; good enough for lobby respawns.
        let spots = GameSim::spawn_positions(8);
        spots[(self.tick as usize / 7) % spots.len()]
    }

    fn handle_join(&mut self, name: String, token: Option<String>) -> Result<JoinAck, String> {
        // Reconnect: a matching token takes over the existing slot, keeping the
        // player's id + score. Works even if the old socket still looks alive
        // (the common half-dead-socket case) — the epoch bump makes any command
        // from the superseded connection a no-op.
        if let Some(tok) = token {
            let existing = self
                .players
                .iter()
                .find(|(_, p)| p.token == tok)
                .map(|(&id, _)| id);
            if let Some(id) = existing {
                return Ok(self.reconnect(id));
            }
        }

        let c = consts();
        if self.players.len() >= c.max_players as usize {
            return Err("room is full".into());
        }
        let id = (0..c.max_players)
            .find(|i| !self.players.contains_key(i))
            .unwrap();
        let (tx, out_rx) = mpsc::unbounded_channel();

        let meta = PlayerMeta {
            id,
            name: sanitize_name(&name),
            slot: id,
        };
        // Announce to existing players first.
        self.broadcast(&ServerMsg::PlayerJoined { meta: meta.clone() });

        let spawn = self.random_spawn();
        self.sim.add_player(id, false, spawn);
        if !matches!(self.phase, RoomPhase::Lobby) {
            // Joined mid-match: spectate until next round.
            self.sim.kill(id);
        }

        let token = gen_token();
        self.players.insert(
            id,
            RoomPlayer {
                meta,
                tx: tx.clone(),
                inputs: VecDeque::new(),
                last_input: PlayerInput::default(),
                last_seq: 0,
                starved: 0,
                score: 0,
                in_round: false,
                token: token.clone(),
                connected: true,
                epoch: 0,
                gone_ticks: 0,
            },
        );

        let welcome = ServerMsg::Welcome {
            your_id: id,
            code: self.code.clone(),
            players: self.players.values().map(|p| p.meta.clone()).collect(),
            phase: self.phase_msg(),
            tick: self.tick,
            token,
        };
        let _ = tx.send(encode(&welcome));
        tracing::info!("room {}: player {id} joined", self.code);
        Ok(JoinAck { id, epoch: 0, out_rx })
    }

    /// Take over an existing slot: swap in the new socket, bump the epoch, and
    /// resend Welcome so the client rebuilds its world.
    fn reconnect(&mut self, id: PlayerId) -> JoinAck {
        let (tx, out_rx) = mpsc::unbounded_channel();
        let (epoch, token) = {
            let p = self.players.get_mut(&id).unwrap();
            p.epoch = p.epoch.wrapping_add(1);
            p.tx = tx.clone();
            p.connected = true;
            p.gone_ticks = 0;
            p.inputs.clear();
            p.last_input = PlayerInput::default();
            (p.epoch, p.token.clone())
        };
        let welcome = ServerMsg::Welcome {
            your_id: id,
            code: self.code.clone(),
            players: self.players.values().map(|p| p.meta.clone()).collect(),
            phase: self.phase_msg(),
            tick: self.tick,
            token,
        };
        let _ = tx.send(encode(&welcome));
        tracing::info!("room {}: player {id} reconnected (epoch {epoch})", self.code);
        JoinAck { id, epoch, out_rx }
    }

    /// True if a command's connection generation matches the live player. Stale
    /// commands from a socket that a reconnect superseded are dropped.
    fn epoch_ok(&self, id: PlayerId, epoch: u32) -> bool {
        self.players.get(&id).map(|p| p.epoch == epoch).unwrap_or(false)
    }

    fn handle_leave(&mut self, id: PlayerId) {
        if !self.players.contains_key(&id) {
            return;
        }
        if matches!(self.phase, RoomPhase::Lobby) {
            // Lobby: nothing to preserve — free the slot immediately so the
            // host/start flow stays unblocked.
            self.players.remove(&id);
            self.sim.remove_player(id);
            self.broadcast(&ServerMsg::PlayerLeft { id });
            // Host may have changed (host = lowest id present).
            self.send_phase();
            tracing::info!("room {}: player {id} left (lobby)", self.code);
        } else {
            // Mid-match: hold the slot + score for the grace window so the
            // player can rejoin. Their body keeps simulating on neutral input.
            let p = self.players.get_mut(&id).unwrap();
            p.connected = false;
            p.gone_ticks = 0;
            p.inputs.clear();
            p.last_input = PlayerInput::default();
            tracing::info!("room {}: player {id} disconnected (grace)", self.code);
        }
    }

    /// Drop players whose reconnect grace window has elapsed.
    fn sweep_disconnected(&mut self) {
        let grace = consts().reconnect_grace_ticks;
        let mut expired = Vec::new();
        for (&id, p) in self.players.iter_mut() {
            if !p.connected {
                p.gone_ticks = p.gone_ticks.saturating_add(1);
                if p.gone_ticks >= grace {
                    expired.push(id);
                }
            }
        }
        for id in expired {
            self.players.remove(&id);
            self.sim.remove_player(id);
            self.broadcast(&ServerMsg::PlayerLeft { id });
            if matches!(self.phase, RoomPhase::Lobby) {
                self.send_phase();
            }
            tracing::info!("room {}: player {id} dropped (reconnect grace elapsed)", self.code);
        }
    }

    fn handle_msg(&mut self, id: PlayerId, msg: ClientMsg) {
        match msg {
            ClientMsg::Input(input) => {
                if let Some(p) = self.players.get_mut(&id) {
                    p.inputs.push_back(input);
                    // Cap backlog: drop oldest under jitter bursts.
                    while p.inputs.len() > 6 {
                        p.inputs.pop_front();
                    }
                }
            }
            ClientMsg::StartMatch => {
                tracing::info!("room {}: StartMatch from p{id}", self.code);
                if Some(id) == self.host()
                    && matches!(self.phase, RoomPhase::Lobby)
                    && !self.players.is_empty()
                {
                    self.start_round(1);
                }
            }
            ClientMsg::Rematch => {
                if Some(id) == self.host() && matches!(self.phase, RoomPhase::MatchEnd) {
                    for p in self.players.values_mut() {
                        p.score = 0;
                    }
                    self.start_round(1);
                }
            }
            ClientMsg::Ping { t } => {
                if let Some(p) = self.players.get(&id) {
                    let _ = p.tx.send(encode(&ServerMsg::Pong { t }));
                }
            }
        }
    }

    /// Wipe queued and remembered inputs (keeps last_seq for reconciliation acks).
    fn clear_inputs(&mut self) {
        for p in self.players.values_mut() {
            p.inputs.clear();
            p.last_input = PlayerInput::default();
        }
    }

    /// Spawn a random pickup on a random unoccupied island.
    fn spawn_pickup(&mut self) {
        let centers = Arena::island_centers();
        let occupied: Vec<u8> = self.sim.pickups.iter().map(|p| p.id).collect();
        let free: Vec<u8> = (0..centers.len() as u8)
            .filter(|i| !occupied.contains(i))
            .collect();
        if free.is_empty() {
            return;
        }
        let mut rng = rand::rng();
        let island = free[rng.random_range(0..free.len())];
        let kind = rng.random_range(powerup::HAMMER..=powerup::BOMB);
        let mut pos = centers[island as usize];
        pos[1] += 0.9; // float above the island surface
        let ev = self.sim.spawn_pickup(island, kind, pos);
        self.pending_events.push(ev);
    }

    fn start_round(&mut self, round: u8) {
        let c = consts();
        self.clear_inputs();
        self.sim.reset_round();
        self.sim.arena_reset();
        let ids: Vec<PlayerId> = self.players.keys().copied().collect();
        let spawns = GameSim::spawn_positions(ids.len());
        for (i, &id) in ids.iter().enumerate() {
            self.sim.respawn(id, spawns[i]);
            self.players.get_mut(&id).unwrap().in_round = true;
        }
        self.phase = RoomPhase::Countdown {
            round,
            start_at: self.tick + c.round_countdown_ticks,
        };
        let (li, ti, lm, tm) = self.sim.arena.debug_audit(&self.sim.colliders);
        tracing::info!(
            "room {}: post-reset audit islands {li}/{ti} main {lm}/{tm}",
            self.code
        );
        self.send_phase();
    }

    fn tick(&mut self) {
        let c = consts();
        self.tick += 1;

        // Drop players whose reconnect grace window has elapsed.
        self.sweep_disconnected();

        // Nobody here: fall back to lobby instead of cycling rounds.
        if self.players.is_empty() {
            if !matches!(self.phase, RoomPhase::Lobby) {
                self.phase = RoomPhase::Lobby;
            }
            return;
        }

        // Phase transitions driven by time.
        match self.phase {
            RoomPhase::Countdown { round, start_at } if self.tick >= start_at => {
                // Drop anything queued/held during the freeze so nobody moves
                // or swings at "GO" from stale pre-round inputs.
                self.clear_inputs();
                self.phase = RoomPhase::Playing {
                    round,
                    started_at: self.tick,
                };
                self.send_phase();
            }
            RoomPhase::RoundEnd { winner, until } if self.tick >= until => {
                let best = self.players.values().map(|p| p.score).max().unwrap_or(0);
                let _ = winner;
                if best >= c.rounds_to_win {
                    self.phase = RoomPhase::MatchEnd;
                    self.send_phase();
                } else {
                    let next_round =
                        self.players.values().map(|p| p.score as u32).sum::<u32>() as u8 + 1;
                    self.start_round(next_round);
                }
            }
            _ => {}
        }

        // Gather inputs.
        let mut inputs: BTreeMap<PlayerId, PlayerInput> = BTreeMap::new();
        let allowed = self.movement_allowed();
        for (&id, p) in self.players.iter_mut() {
            if let Some(msg) = p.inputs.pop_front() {
                p.starved = 0;
                p.last_seq = msg.seq;
                p.last_input = PlayerInput {
                    move_x: protocol::dequant_move(msg.move_x),
                    move_z: protocol::dequant_move(msg.move_z),
                    yaw: protocol::dequant_yaw_u16(msg.yaw),
                    buttons: msg.buttons,
                };
            } else {
                p.starved = p.starved.saturating_add(1);
                if p.starved == INPUT_STALE_TICKS {
                    p.last_input = PlayerInput::default();
                }
            }
            if allowed {
                inputs.insert(id, p.last_input);
            }
        }

        // Arena shrink + pickup drops only during play.
        if let RoomPhase::Playing { started_at, .. } = self.phase {
            let round_tick = self.tick - started_at;
            let evs = self.sim.arena_apply_until(round_tick);
            self.pending_events.extend(evs);

            if round_tick >= c.pickup_first_spawn_ticks
                && (round_tick - c.pickup_first_spawn_ticks) % c.pickup_spawn_interval_ticks == 0
            {
                self.spawn_pickup();
            }
        }

        // Step the world.
        let events = self.sim.step(&inputs);

        // Deaths.
        let mut deaths: Vec<PlayerId> = Vec::new();
        for ev in &events {
            if let SimEvent::Death { player, pos, vel } = ev {
                tracing::info!(
                    "room {}: death p{player} at {pos:?} vel {vel:?} tick {}",
                    self.code,
                    self.tick
                );
                deaths.push(*player);
            }
        }
        self.pending_events.extend(events);

        match self.phase {
            RoomPhase::Lobby => {
                // Lobby: falling just respawns you.
                for id in deaths {
                    let spawn = self.random_spawn();
                    self.sim.respawn(id, spawn);
                }
            }
            RoomPhase::Playing { .. } => {
                for id in deaths {
                    if let Some(p) = self.players.get_mut(&id) {
                        p.in_round = false;
                    }
                }
                let alive: Vec<PlayerId> = self
                    .players
                    .iter()
                    .filter(|(_, p)| p.in_round)
                    .map(|(&id, _)| id)
                    .collect();
                let participants = self.players.len();
                let over = if participants >= 2 {
                    alive.len() <= 1
                } else {
                    alive.is_empty()
                };
                if over {
                    let winner = alive.first().copied();
                    if let Some(w) = winner {
                        if let Some(p) = self.players.get_mut(&w) {
                            p.score += 1;
                        }
                    }
                    self.phase = RoomPhase::RoundEnd {
                        winner,
                        until: self.tick + c.round_end_pause_ticks,
                    };
                    self.send_phase();
                }
            }
            _ => {}
        }

        // Snapshots at tick_rate / snapshot_divisor.
        if self.tick % c.snapshot_divisor == 0 {
            self.send_snapshots();
            self.pending_events.clear();
        }
    }

    fn send_snapshots(&mut self) {
        let net_players: Vec<NetPlayer> = self
            .players
            .iter()
            .filter_map(|(&id, rp)| {
                let snap = self.sim.snapshot(id)?;
                let mut flags = 0u8;
                if snap.state.grounded {
                    flags |= player_flags::GROUNDED;
                }
                if snap.state.launched > 0 {
                    flags |= player_flags::LAUNCHED;
                }
                if snap.alive {
                    flags |= player_flags::ALIVE;
                }
                if !rp.connected {
                    flags |= player_flags::DISCONNECTED;
                }
                Some(NetPlayer {
                    id,
                    px: protocol::quant_pos(snap.pos[0]),
                    py: protocol::quant_pos(snap.pos[1]),
                    pz: protocol::quant_pos(snap.pos[2]),
                    vx: protocol::quant_vel(snap.vel[0]),
                    vy: protocol::quant_vel(snap.vel[1]),
                    vz: protocol::quant_vel(snap.vel[2]),
                    yaw: protocol::quant_yaw_u8(snap.state.facing),
                    anim: self.sim.anim_state(id) as u8,
                    flags,
                    damage: snap.damage,
                    powerup: snap.state.powerup,
                })
            })
            .collect();

        let net_pickups: Vec<NetPickup> = self
            .sim
            .pickups
            .iter()
            .map(|k| NetPickup {
                id: k.id,
                kind: k.kind,
                px: protocol::quant_pos(k.pos[0]),
                py: protocol::quant_pos(k.pos[1]),
                pz: protocol::quant_pos(k.pos[2]),
            })
            .collect();

        let net_projectiles: Vec<NetProjectile> = self
            .sim
            .projectiles
            .iter()
            .map(|pr| NetProjectile {
                id: pr.id,
                kind: pr.kind,
                px: protocol::quant_pos(pr.pos.x),
                py: protocol::quant_pos(pr.pos.y),
                pz: protocol::quant_pos(pr.pos.z),
                vx: protocol::quant_vel(pr.vel.x),
                vy: protocol::quant_vel(pr.vel.y),
                vz: protocol::quant_vel(pr.vel.z),
            })
            .collect();

        for (&id, p) in &self.players {
            // No live socket for a disconnected player awaiting reconnect.
            if !p.connected {
                continue;
            }
            let msg = ServerMsg::Snapshot(SnapshotMsg {
                tick: self.tick,
                last_input_seq: p.last_seq,
                input_buffer_len: p.inputs.len().min(255) as u8,
                players: net_players.clone(),
                pickups: net_pickups.clone(),
                projectiles: net_projectiles.clone(),
                local: self.sim.snapshot(id),
                events: self.pending_events.clone(),
            });
            let _ = p.tx.send(encode(&msg));
        }
    }
}

pub fn spawn_room(code: String, state: Arc<AppState>) -> RoomHandle {
    let (tx, mut rx) = mpsc::unbounded_channel::<RoomCmd>();
    let c = consts();
    let tick_dur = Duration::from_secs_f64(1.0 / c.tick_rate as f64);

    tokio::spawn(async move {
        let mut room = Room {
            code: code.clone(),
            sim: GameSim::new(true),
            players: BTreeMap::new(),
            phase: RoomPhase::Lobby,
            tick: 0,
            pending_events: Vec::new(),
            empty_ticks: 0,
        };
        let mut interval = tokio::time::interval(tick_dur);

        loop {
            interval.tick().await;

            // Drain commands, but bounded per tick so a burst can't monopolize
            // the room task (per-connection rate limiting bounds steady-state
            // inflow; this is belt-and-braces against a spike).
            let mut drained = 0u32;
            loop {
                if drained >= CMD_DRAIN_CAP {
                    break;
                }
                match rx.try_recv() {
                    Ok(RoomCmd::Join { name, token, resp }) => {
                        let _ = resp.send(room.handle_join(name, token));
                    }
                    Ok(RoomCmd::Msg { id, epoch, msg }) => {
                        if room.epoch_ok(id, epoch) {
                            room.handle_msg(id, msg);
                        }
                    }
                    Ok(RoomCmd::Leave { id, epoch }) => {
                        if room.epoch_ok(id, epoch) {
                            room.handle_leave(id);
                        }
                    }
                    Ok(RoomCmd::Shutdown) => {
                        room.broadcast(&ServerMsg::Error {
                            msg: "server restarting — please rejoin".into(),
                        });
                        tracing::info!("room {code} shutting down");
                        return;
                    }
                    Err(mpsc::error::TryRecvError::Empty) => break,
                    Err(mpsc::error::TryRecvError::Disconnected) => return,
                }
                drained += 1;
            }

            room.tick();

            // Cleanup: shut the room down after ~2 minutes with nobody in it.
            if room.players.is_empty() {
                room.empty_ticks += 1;
                if room.empty_ticks > c.tick_rate * 120 {
                    state.rooms.remove(&code);
                    tracing::info!("room {code} closed (idle)");
                    return;
                }
            } else {
                room.empty_ticks = 0;
            }
        }
    });

    tx
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::InputMsg;

    pub(super) fn test_room() -> Room {
        Room {
            code: "TEST".into(),
            sim: GameSim::new(true),
            players: BTreeMap::new(),
            phase: RoomPhase::Lobby,
            tick: 0,
            pending_events: Vec::new(),
            empty_ticks: 0,
        }
    }

    fn held_input(seq: u16) -> ClientMsg {
        ClientMsg::Input(InputMsg {
            seq,
            move_x: 0,
            move_z: 127, // holding forward
            yaw: 0,
            buttons: sim::types::buttons::LIGHT | sim::types::buttons::JUMP,
        })
    }

    #[test]
    fn names_are_sanitized_on_join() {
        // Control chars stripped, length clamped, empty falls back to "Player".
        assert_eq!(sanitize_name("Alice"), "Alice");
        assert_eq!(sanitize_name("Bad\u{0000}Name"), "BadName");
        assert_eq!(sanitize_name("line\nbreak"), "linebreak");
        assert_eq!(sanitize_name("   "), "Player");
        assert_eq!(sanitize_name(""), "Player");
        assert!(sanitize_name("012345678901234567890").chars().count() <= 16);

        // The stored meta name reflects the sanitized value (angle brackets are
        // legal text — the client escapes them at render).
        let mut room = test_room();
        room.handle_join("Zoe\u{0007}\t".into(), None).unwrap();
        let name = &room.players.get(&0).unwrap().meta.name;
        assert!(!name.chars().any(|c| c.is_control()));
        assert_eq!(name, "Zoe");
    }

    #[test]
    fn input_backlog_is_capped() {
        // A client spamming inputs within one tick can't grow the backlog
        // unbounded — it's clamped to the jitter buffer size.
        let mut room = test_room();
        room.handle_join("A".into(), None).unwrap();
        for seq in 1..=100u16 {
            room.handle_msg(0, held_input(seq));
        }
        assert!(
            room.players.get(&0).unwrap().inputs.len() <= 6,
            "input backlog exceeded cap"
        );
    }

    /// Regression: inputs queued/held during the round-end/countdown freeze
    /// must not replay when the next round starts.
    #[test]
    fn stale_inputs_do_not_replay_at_round_start() {
        let c = consts();
        let mut room = test_room();
        room.handle_join("A".into(), None).unwrap();
        room.handle_join("B".into(), None).unwrap();

        // Lobby: hold forward + mash buttons for a bit.
        let mut seq = 0u16;
        for _ in 0..30 {
            seq += 1;
            room.handle_msg(0, held_input(seq));
            room.tick();
        }

        // Host starts the match; client keeps mashing for a few more ticks
        // (simulates inputs in flight when the phase change lands).
        room.handle_msg(0, ClientMsg::StartMatch);
        for _ in 0..5 {
            seq += 1;
            room.handle_msg(0, held_input(seq));
            room.tick();
        }

        // Tick through the countdown into Playing with no fresh input.
        for _ in 0..(c.round_countdown_ticks + 2) {
            room.tick();
        }
        assert!(
            matches!(room.phase, RoomPhase::Playing { .. }),
            "should be playing"
        );

        let start = room.sim.snapshot(0).unwrap();
        for _ in 0..30 {
            room.tick();
        }
        let after = room.sim.snapshot(0).unwrap();

        let dx = after.pos[0] - start.pos[0];
        let dz = after.pos[2] - start.pos[2];
        assert!(
            (dx * dx + dz * dz).sqrt() < 0.05,
            "player moved {dx},{dz} from stale inputs at round start"
        );
        assert_eq!(
            after.state.attack.kind,
            sim::types::AttackKind::None,
            "phantom attack fired at round start"
        );
        assert_eq!(after.state.jump_count, 0, "phantom jump at round start");
    }
}

#[cfg(test)]
mod reconnect_tests {
    use super::tests::test_room;
    use super::*;

    fn playing_room_with_two() -> Room {
        let mut room = test_room();
        room.handle_join("A".into(), None).unwrap();
        room.handle_join("B".into(), None).unwrap();
        room.handle_msg(0, ClientMsg::StartMatch);
        for _ in 0..(consts().round_countdown_ticks + 2) {
            room.tick();
        }
        assert!(matches!(room.phase, RoomPhase::Playing { .. }));
        room
    }

    #[test]
    fn reconnect_preserves_id_and_score() {
        let mut room = playing_room_with_two();
        room.players.get_mut(&0).unwrap().score = 2;
        let token = room.players.get(&0).unwrap().token.clone();
        let old_epoch = room.players.get(&0).unwrap().epoch;

        // Mid-match disconnect holds the slot rather than removing it.
        room.handle_leave(0);
        assert!(room.players.contains_key(&0), "slot held during grace");
        assert!(!room.players.get(&0).unwrap().connected);

        let ack = room.handle_join("A".into(), Some(token)).unwrap();
        assert_eq!(ack.id, 0, "rejoined same slot");
        assert!(ack.epoch > old_epoch, "epoch bumped on reconnect");
        let p = room.players.get(&0).unwrap();
        assert!(p.connected);
        assert_eq!(p.score, 2, "score preserved across reconnect");
    }

    #[test]
    fn grace_expiry_drops_player() {
        let mut room = playing_room_with_two();
        room.handle_leave(0);
        assert!(room.players.contains_key(&0));
        for _ in 0..(consts().reconnect_grace_ticks + 1) {
            room.tick();
        }
        assert!(!room.players.contains_key(&0), "dropped after grace window");
    }

    #[test]
    fn stale_epoch_leave_ignored_after_takeover() {
        let mut room = playing_room_with_two();
        let token = room.players.get(&0).unwrap().token.clone();
        let old_epoch = room.players.get(&0).unwrap().epoch;

        let ack = room.handle_join("A".into(), Some(token)).unwrap();
        assert_ne!(ack.epoch, old_epoch);

        // A Leave from the superseded socket carries the old epoch: ignored.
        if room.epoch_ok(0, old_epoch) {
            room.handle_leave(0);
        }
        assert!(
            room.players.get(&0).unwrap().connected,
            "stale-epoch leave must not disconnect the reconnected player"
        );

        // The current connection's Leave still works.
        if room.epoch_ok(0, ack.epoch) {
            room.handle_leave(0);
        }
        assert!(!room.players.get(&0).unwrap().connected);
    }

    #[test]
    fn lobby_disconnect_removes_immediately() {
        let mut room = test_room();
        room.handle_join("A".into(), None).unwrap();
        room.handle_join("B".into(), None).unwrap();
        room.handle_leave(1);
        assert!(
            !room.players.contains_key(&1),
            "lobby disconnect frees the slot at once"
        );
    }

    #[test]
    fn unknown_token_falls_back_to_fresh_join() {
        let mut room = test_room();
        let ack = room
            .handle_join("A".into(), Some("deadbeefdeadbeef".into()))
            .unwrap();
        assert_eq!(ack.id, 0);
        assert_eq!(ack.epoch, 0, "unknown token => fresh join, not a reconnect");
        assert!(room.players.contains_key(&0));
    }
}

#[cfg(test)]
mod stale_input_tests {
    use super::*;
    use protocol::InputMsg;
    use std::collections::BTreeMap as BTM;

    /// A client that stops sending (throttled tab) must not keep walking
    /// forever on its last held input.
    #[test]
    fn stale_input_neutralizes_after_timeout() {
        let mut room = Room {
            code: "TST2".into(),
            sim: GameSim::new(true),
            players: BTM::new(),
            phase: RoomPhase::Lobby,
            tick: 0,
            pending_events: Vec::new(),
            empty_ticks: 0,
        };
        room.handle_join("A".into(), None).unwrap();
        // Send one forward input, then go silent.
        room.handle_msg(
            0,
            ClientMsg::Input(InputMsg { seq: 1, move_x: 0, move_z: 127, yaw: 0, buttons: 0 }),
        );
        // The held input applies for a while, then must be zeroed.
        for _ in 0..(INPUT_STALE_TICKS as u32 + 60) {
            room.tick();
        }
        let s1 = room.sim.snapshot(0).unwrap();
        for _ in 0..30 {
            room.tick();
        }
        let s2 = room.sim.snapshot(0).unwrap();
        let moved = ((s2.pos[0] - s1.pos[0]).powi(2) + (s2.pos[2] - s1.pos[2]).powi(2)).sqrt();
        assert!(
            moved < 0.05,
            "player still moving {moved} on stale input after timeout"
        );
    }
}
