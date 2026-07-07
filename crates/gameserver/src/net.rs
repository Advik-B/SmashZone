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
}

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(q): Query<WsQuery>,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, q, state))
}

async fn handle_socket(socket: WebSocket, q: WsQuery, state: Arc<AppState>) {
    let code = q.code.trim().to_uppercase();
    let name = if q.name.trim().is_empty() {
        "Player".to_string()
    } else {
        q.name.trim().to_string()
    };

    let Some(room_tx) = state.rooms.get(&code).map(|r| r.value().clone()) else {
        let _ = send_error(socket, "room not found").await;
        return;
    };

    let (ack_tx, ack_rx) = oneshot::channel();
    if room_tx
        .send(RoomCmd::Join {
            name,
            resp: ack_tx,
        })
        .is_err()
    {
        let _ = send_error(socket, "room is closed").await;
        return;
    }
    let JoinAck { id, mut out_rx } = match ack_rx.await {
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

    // Reader: socket -> room.
    while let Some(Ok(msg)) = stream.next().await {
        match msg {
            Message::Binary(bytes) => {
                if let Some(cmsg) = protocol::decode::<protocol::ClientMsg>(&bytes) {
                    if room_tx.send(RoomCmd::Msg { id, msg: cmsg }).is_err() {
                        break;
                    }
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    let _ = room_tx.send(RoomCmd::Leave { id });
    writer.abort();
}

async fn send_error(mut socket: WebSocket, msg: &str) -> Result<(), axum::Error> {
    let bytes = protocol::encode(&protocol::ServerMsg::Error {
        msg: msg.to_string(),
    });
    socket.send(Message::Binary(bytes.into())).await?;
    socket.close().await
}
