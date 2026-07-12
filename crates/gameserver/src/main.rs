mod bot;
mod net;
mod room;

use axum::extract::State;
use axum::http::{header, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, post};
use axum::{Json, Router};
use dashmap::DashMap;
use rand::Rng;
use std::sync::Arc;

// Web client embedded at compile time by build.rs — the binary is the deploy.
mod static_assets {
    include!(concat!(env!("OUT_DIR"), "/static_assets.rs"));
}
use static_assets::STATIC_ASSETS;

async fn serve_static(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    let asset = STATIC_ASSETS
        .iter()
        .find(|a| a.path == path)
        // SPA fallback: unknown routes get the app shell.
        .or_else(|| STATIC_ASSETS.iter().find(|a| a.path == "index.html"));
    match asset {
        Some(a) => {
            // Vite content-hashes everything under assets/; index.html must revalidate.
            let cache = if a.path.starts_with("assets/") {
                "public, max-age=31536000, immutable"
            } else {
                "no-cache"
            };
            (
                [
                    (header::CONTENT_TYPE, a.mime),
                    (header::CACHE_CONTROL, cache),
                ],
                a.bytes,
            )
                .into_response()
        }
        None => (
            StatusCode::NOT_FOUND,
            "no embedded web client in this build",
        )
            .into_response(),
    }
}

pub struct AppState {
    pub rooms: DashMap<String, room::RoomHandle>,
}

/// Hard cap on live rooms. Each room is a permanent 60 Hz tokio task, so
/// uncapped `POST /api/rooms` would be an easy CPU/memory DoS.
const MAX_ROOMS: usize = 256;

/// True if a new room may be created given the current live-room count.
fn room_capacity_available(live_rooms: usize) -> bool {
    live_rooms < MAX_ROOMS
}

fn gen_code(rooms: &DashMap<String, room::RoomHandle>) -> String {
    // No 0/O/1/I/L ambiguity.
    const ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    let mut rng = rand::rng();
    loop {
        let code: String = (0..4)
            .map(|_| ALPHABET[rng.random_range(0..ALPHABET.len())] as char)
            .collect();
        if !rooms.contains_key(&code) {
            return code;
        }
    }
}

async fn create_room(State(state): State<Arc<AppState>>) -> Response {
    if !room_capacity_available(state.rooms.len()) {
        tracing::warn!("room creation refused: at capacity ({MAX_ROOMS})");
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({ "error": "server is full, try again soon" })),
        )
            .into_response();
    }
    let code = gen_code(&state.rooms);
    let handle = room::spawn_room(code.clone(), state.clone());
    state.rooms.insert(code.clone(), handle);
    tracing::info!("room {code} created");
    Json(serde_json::json!({ "code": code })).into_response()
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();
    let state = Arc::new(AppState {
        rooms: DashMap::new(),
    });

    let app = Router::new()
        .route("/api/health", axum::routing::get(|| async { "ok" }))
        .route("/api/rooms", post(create_room))
        .route("/ws", any(net::ws_handler))
        .fallback(serve_static)
        .with_state(state.clone());

    // BIND_ADDR wins; else PORT (Render/Heroku-style PaaS); else :8080.
    let addr = std::env::var("BIND_ADDR").unwrap_or_else(|_| {
        let port = std::env::var("PORT").unwrap_or_else(|_| "8080".into());
        format!("0.0.0.0:{port}")
    });
    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    tracing::info!("gameserver listening on {addr}");

    // Serve until a shutdown signal, then notify rooms so clients get a clean
    // "server restarting" message instead of a silent socket drop.
    tokio::select! {
        r = axum::serve(listener, app) => r.unwrap(),
        _ = shutdown_signal() => {
            tracing::info!("shutdown signal received; notifying {} room(s)", state.rooms.len());
            for entry in state.rooms.iter() {
                let _ = entry.value().send(room::RoomCmd::Shutdown);
            }
            // Give writer tasks a moment to flush the notice before exit.
            tokio::time::sleep(std::time::Duration::from_millis(750)).await;
        }
    }
}

/// Resolves on SIGINT (Ctrl-C) or SIGTERM (Fly deploy / auto-stop).
async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut sig) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            sig.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {}
        _ = terminate => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn room_capacity_gate() {
        assert!(room_capacity_available(0));
        assert!(room_capacity_available(MAX_ROOMS - 1));
        assert!(!room_capacity_available(MAX_ROOMS));
        assert!(!room_capacity_available(MAX_ROOMS + 100));
    }
}
