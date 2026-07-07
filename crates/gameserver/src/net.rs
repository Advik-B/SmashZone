//! WebSocket plumbing: one reader + one writer task per connection,
//! bridged to the room task via channels.

use crate::room::{JoinAck, RoomCmd};
use crate::AppState;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::response::IntoResponse;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use std::sync::Arc;
use tokio::sync::oneshot;

#[derive(Deserialize)]
pub struct WsQuery {
    code: String,
    name: String,
    /// Session token from a prior Welcome, present when rejoining.
    token: Option<String>,
}

/// Client messages are tiny (largest legit `ClientMsg` is ~16 bytes). Cap the
/// frame/message size so a single crafted frame can't be read into memory
/// before the postcard decode rejects it.
const WS_MAX_MSG_BYTES: usize = 1024;

/// Per-connection fixed-window rate limit. 60 Hz inputs + 0.5 Hz pings is
/// ~120 msgs / 2 s in the worst legit case; 300 leaves generous headroom while
/// still cutting off a flooder.
const RATE_LIMIT_MSGS: u32 = 300;
const RATE_LIMIT_WINDOW: std::time::Duration = std::time::Duration::from_secs(2);

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(q): Query<WsQuery>,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.max_message_size(WS_MAX_MSG_BYTES)
        .max_frame_size(WS_MAX_MSG_BYTES)
        .on_upgrade(move |socket| handle_socket(socket, q, state))
}

async fn handle_socket(socket: WebSocket, q: WsQuery, state: Arc<AppState>) {
    let code = q.code.trim().to_uppercase();
    let name = if q.name.trim().is_empty() {
        "Player".to_string()
    } else {
        q.name.trim().to_string()
    };
    let token = q.token.filter(|t| !t.is_empty());

    let Some(room_tx) = state.rooms.get(&code).map(|r| r.value().clone()) else {
        let _ = send_error(socket, "room not found").await;
        return;
    };

    let (ack_tx, ack_rx) = oneshot::channel();
    if room_tx
        .send(RoomCmd::Join {
            name,
            token,
            resp: ack_tx,
        })
        .is_err()
    {
        let _ = send_error(socket, "room is closed").await;
        return;
    }
    let JoinAck { id, epoch, mut out_rx } = match ack_rx.await {
        Ok(Ok(ack)) => ack,
        Ok(Err(e)) => {
            let _ = send_error(socket, &e).await;
            return;
        }
        Err(_) => return,
    };

    let (mut sink, mut stream) = socket.split();

    // Writer: room -> socket.
    let writer = tokio::spawn(async move {
        while let Some(bytes) = out_rx.recv().await {
            if sink.send(Message::Binary(bytes.into())).await.is_err() {
                break;
            }
        }
    });

    // Reader: socket -> room. Fixed-window rate limit disconnects a flooder.
    let mut window_start = std::time::Instant::now();
    let mut window_count: u32 = 0;
    while let Some(Ok(msg)) = stream.next().await {
        let now = std::time::Instant::now();
        if now.duration_since(window_start) >= RATE_LIMIT_WINDOW {
            window_start = now;
            window_count = 0;
        }
        window_count += 1;
        if window_count > RATE_LIMIT_MSGS {
            tracing::warn!("player {id} exceeded rate limit; closing connection");
            break;
        }

        match msg {
            Message::Binary(bytes) => {
                if let Some(cmsg) = protocol::decode::<protocol::ClientMsg>(&bytes) {
                    if room_tx.send(RoomCmd::Msg { id, epoch, msg: cmsg }).is_err() {
                        break;
                    }
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    let _ = room_tx.send(RoomCmd::Leave { id, epoch });
    writer.abort();
}

async fn send_error(mut socket: WebSocket, msg: &str) -> Result<(), axum::Error> {
    let bytes = protocol::encode(&protocol::ServerMsg::Error {
        msg: msg.to_string(),
    });
    socket.send(Message::Binary(bytes.into())).await?;
    socket.close().await
}
