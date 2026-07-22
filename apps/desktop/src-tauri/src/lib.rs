use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::menu::{AboutMetadata, Menu, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{Emitter, Manager, RunEvent, State};

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


/// 原生应用菜单：`Socrates > Settings…`（⌘,）发出 `menu://settings`，
/// 前端据此聚焦**同一个** Settings overlay 实例，不新建窗口。
/// 非 macOS 平台保留系统默认菜单，快捷键仍由前端的 Ctrl+, 覆盖。
fn build_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let settings = MenuItemBuilder::with_id("settings", "Settings…")
        .accelerator("CmdOrCtrl+,")
        .build(app)?;
    let app_menu = SubmenuBuilder::new(app, "Socrates")
        .item(&PredefinedMenuItem::about(app, Some("About Socrates"), Some(AboutMetadata::default()))?)
        .separator()
        .item(&settings)
        .separator()
        .item(&PredefinedMenuItem::services(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::hide(app, None)?)
        .item(&PredefinedMenuItem::hide_others(app, None)?)
        .item(&PredefinedMenuItem::show_all(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::quit(app, None)?)
        .build()?;
    // 保留编辑菜单，否则 WebView 里的复制/粘贴快捷键在 macOS 上会失效
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .item(&PredefinedMenuItem::undo(app, None)?)
        .item(&PredefinedMenuItem::redo(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .build()?;
    Menu::with_items(app, &[&app_menu, &edit_menu])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(SidecarState::default())
        .invoke_handler(tauri::generate_handler![sidecar_handshake])
        .setup(|app| {
            let handle = app.handle().clone();
            #[cfg(target_os = "macos")]
            {
                app.set_menu(build_menu(&handle)?)?;
            }
            spawn_sidecar(handle);
            Ok(())
        })
        .on_menu_event(|app, event| {
            if event.id() == "settings" {
                let _ = app.emit("menu://settings", ());
            }
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
