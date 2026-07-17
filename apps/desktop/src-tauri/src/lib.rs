use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{Manager, RunEvent, State};

const HANDSHAKE_PROTOCOL: &str = "socrates-sidecar/1";

#[derive(Clone, serde::Serialize)]
struct SidecarHandshake {
    port: u16,
    token: String,
}

#[derive(Default)]
struct SidecarState {
    handshake: Mutex<Option<SidecarHandshake>>,
    child: Mutex<Option<Child>>,
}

#[tauri::command]
fn sidecar_handshake(state: State<SidecarState>) -> Option<SidecarHandshake> {
    state.handshake.lock().unwrap().clone()
}

fn parse_handshake(line: &str) -> Option<SidecarHandshake> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    if v["protocol"] != HANDSHAKE_PROTOCOL {
        return None;
    }
    let port = u16::try_from(v["port"].as_u64()?).ok()?;
    let token = v["token"].as_str()?.to_string();
    if port == 0 || token.is_empty() {
        return None;
    }
    Some(SidecarHandshake { port, token })
}

// ponytail: dev-only spawn via bun; bundled sidecar binary comes with release packaging (out of MVP scope)
fn spawn_sidecar(app: tauri::AppHandle) {
    let entry = concat!(env!("CARGO_MANIFEST_DIR"), "/../../sidecar/src/index.ts");
    let child = Command::new("bun")
        .arg("run")
        .arg(entry)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn();
    let mut child = match child {
        Ok(c) => c,
        Err(e) => {
            eprintln!("failed to spawn sidecar (is bun on PATH?): {e}");
            return;
        }
    };
    let stdout = child.stdout.take().expect("sidecar stdout is piped");
    *app.state::<SidecarState>().child.lock().unwrap() = Some(child);
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let state = app.state::<SidecarState>();
            let mut handshake = state.handshake.lock().unwrap();
            if handshake.is_none() {
                if let Some(h) = parse_handshake(&line) {
                    *handshake = Some(h);
                    continue;
                }
            }
            drop(handshake);
            println!("[sidecar] {line}");
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(SidecarState::default())
        .invoke_handler(tauri::generate_handler![sidecar_handshake])
        .setup(|app| {
            spawn_sidecar(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(mut child) = app.state::<SidecarState>().child.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        });
}
