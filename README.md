# JotaOverlay

This project is a professional overlay system for Rocket League broadcasts, designed to integrate with the **new official Rocket League Stats API** (Rocket League Stats API) released with the Rocket League Easy Anti-Cheat (EAC) update in April 2026.

## Features

*   Native integration with the new Rocket League Stats API.
*   Automatic overlay compatible with broadcasting software (OBS, Streamlabs Desktop, etc.) using a browser source.
    *   Ingame screen compatible with 1v1, 2v2, 3v3, and 4v4.
    *   Tags with player names, boost, and other stats.
    *   Automatic goal screen with goal statistics (scorer, speed, and assist).
    *   Post-match screen with scoreboards and MVP.
*   Control panel to manage team names, logos, and series scores manually. Allows changes during the match.
*   Ability to save teams for more convenient later use.
*   Automatic match winner detection and series score update.
*   Fully portable and ready to use for streamers and casters, simply run the .exe file.

## Screenshots

![Overlay 1](screenshots/overlay1.png)
![Overlay 2](screenshots/overlay2.png)
![Overlay 3](screenshots/overlay3.png)

<p align="center">
  <img src="screenshots/control-panel1.png" width="48%" />
  <img src="screenshots/control-panel2.png" width="48%" />
</p>

## Streaming Setup

1.  **Activate the official API:** 
    - [ ] Close Rocket League (if open).
    - [ ] Go to the file `<Rocket League installation directory>/TAGame/Config/DefaultStatsAPI.ini`.
    - [ ] Change the `PacketSendRate` value to `30` (or higher).
    - [ ] Save the file.
    - [ ] Start Rocket League.
2.  **Configure the overlay in your streaming software:**
    - [ ] Open JotaOverlay.exe.
    - [ ] In your streaming software, create a new browser source above your game:
        *   URL:
        ```javascript
        http://localhost:3000
        ```
        *   Resolution: `1920x1080`
    - [ ] The overlay will be displayed on the screen.

## 🚀 System Architecture

The program works as a "bridge" between the game data and the visual interface:

1.  **Data Layer (Rocket League):** The game emits real-time data through its internal stats API.
2.  **Server Layer (Backend):** A Node.js server (`server.js`) acts as a TCP client to receive, process, and distribute this data.
3.  **Visual Layer (Frontend):** Both the Overlay and the Control Panel are web applications that update via WebSockets.

---

## 📂 File Guide

### 🧠 System Core
*   **`main.js`**: Electron entry point. Configures the Control Panel window and starts the backend server.
*   **`server.js`**: The most critical component. It contains:
    *   **TCP Client**: Connects to the game's port 49123.
    *   **State Logic**: Maintains scores, time, active players, and goal events.
    *   **WebSocket Server**: Re-emits processed data to the overlay (port 3001).
*   **`package.json`**: Defines dependencies (`express`, `ws`, `electron`) and build commands.

### 🎨 Interfaces
*   **`overlay/`**: The visual part imported into streaming software (via Browser Source).
    *   `index.html`: Scoreboard and HUD structure.
    *   `app.js`: Logic that receives data from the WebSocket (port 3001) and updates the HTML.
*   **`control-panel/`**: Tool to manage team names, logos, and series scores manually.

### 📦 Resources and Persistence
*   **`assets/`**: Images, default logos, and fonts.
*   **`data/`**: Persistently stores configured teams (`teams.json`), their logos, and the application state (`state.json`).

---

## 🔌 Integration with Rocket League Stats API

This overlay is specifically designed to work with the official **Rocket League Stats API** from Psyonix.

### 1. Technical Connection
The server connects via a **TCP Socket** to the local address on port **49123**.

```javascript
// Connection in server.js
rlSocket.connect(49123, '127.0.0.1', () => {
  console.log('[RL] Connected to Stats API (TCP)');
});
```

### 2. Processed Events
The code is prepared to interpret the official JSON packets from the API:
*   **`UpdateState`**: General update (scoreboard, time, player boost).
*   **`GoalScored`**: Information about the goal scorer and speed.
*   **`ClockUpdatedSeconds`**: Precise timer synchronization.
*   **`MatchCreated` / `MatchEnded`**: State reset and series management.

### 🛠️ Why is it not receiving data?
If the overlay is not updating, check the following:
*   **Activate the API:** For Rocket League to emit this data, you must change the `PacketSendRate` value to at least `30` in the `<Install Dir>/TAGame/Config/DefaultStatsAPI.ini` file.
*   **Official API Usage:** This version uses the native Rocket League API. It **does not** require BakkesMod or the SOS plugin to work.
*   **Port 49123:** This is the standard Stats API port. Make sure no firewall is blocking local traffic on this port.
*   **Local Address:** The program looks for the game at `127.0.0.1`. The game and this program must run on the same PC.

---

## 📦 Project Build

To generate the portable executable (`.exe`) for Windows:

1.  Install dependencies: `npm install`
2.  Generate the build: `npm run build`
3.  The resulting file will appear in the **`dist/`** folder as `JotaOverlay.exe`.
