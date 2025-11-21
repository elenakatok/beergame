// src/App.tsx
import React, { useState } from "react";
import HostLobby from "./components/HostLobby";
import PlayerJoin from "./components/PlayerJoin";
import PlayerView from "./components/PlayerView";

type View = "home" | "host" | "join" | "player";

const App: React.FC = () => {
  // Always start on home
  const [view, setView] = useState<View>("home");

  return (
    <div
      style={{
        maxWidth: "960px",
        margin: "0 auto",
        padding: "1.5rem 1rem 2rem",
        fontFamily:
          "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      }}
    >
      {view === "home" && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "1rem",
          }}
        >
          <div>
            <h1>Beer Distribution Classroom Game</h1>
            <p style={{ maxWidth: "600px" }}>
              React + Firebase implementation. Host creates a game and
              students join as Retailer, Wholesaler, Distributor, or Factory.
            </p>
          </div>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "1rem",
            }}
          >
            <button onClick={() => setView("host")}>Host a game</button>
            <button onClick={() => setView("join")}>Join a game</button>
          </div>
        </div>
      )}

      {view === "host" && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "0.75rem",
          }}
        >
          <button onClick={() => setView("home")}>← Back</button>
          <HostLobby />
        </div>
      )}

      {view === "join" && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "0.75rem",
          }}
        >
          <button onClick={() => setView("home")}>← Back</button>
          <PlayerJoin
            onJoined={() => {
              setView("player");
            }}
          />
        </div>
      )}

      {view === "player" && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "0.75rem",
          }}
        >
          <button onClick={() => setView("home")}>← Back</button>
          <PlayerView />
        </div>
      )}
    </div>
  );
};

export default App;
