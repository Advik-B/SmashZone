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
        None => (StatusCode::NOT_FOUND, "no embedded web client in this build").into_response(),
    }
}

pub struct AppState {
    pub rooms: DashMap<String, room::RoomHandle>,
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

async fn create_room(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let code = gen_code(&state.rooms);
    let handle = room::spawn_room(code.clone(), state.clone());
    state.rooms.insert(code.clone(), handle);
    tracing::info!("room {code} created");
    Json(serde_json::json!({ "code": code }))
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
        .with_state(state);

    let addr = std::env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".into());
    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    tracing::info!("gameserver listening on {addr}");
    axum::serve(listener, app).await.unwrap();
}
