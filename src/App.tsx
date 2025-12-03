// src/App.tsx
import React, { useState } from "react";
import HostLobby from "./components/HostLobby";
import PlayerJoin from "./components/PlayerJoin";
import PlayerView from "./components/PlayerView";
import titleBg from "./beergametitle.png";

type View = "home" | "host" | "join" | "player";

const App: React.FC = () => {
  // Always start on home
  const [view, setView] = useState<View>("home");

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        justifyContent: "center",
        alignItems: "flex-start",
        padding: "2rem 1rem",
        background: "#f7f7f7",
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          width: "min(960px, 100%)",
          margin: "0 auto",
          padding: "1.5rem 1.25rem 2rem",
          fontFamily:
            "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
          background: "#ffffff",
          borderRadius: "1rem",
          boxShadow: "0 12px 30px rgba(0,0,0,0.08)",
        }}
      >
        {view === "home" && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "1rem",
              backgroundImage: `linear-gradient(135deg, rgba(255,255,255,0.92), rgba(255,255,255,0.85)), url(${titleBg})`,
              backgroundSize: "cover",
              backgroundPosition: "center",
              borderRadius: "1rem",
              padding: "1.25rem",
              boxShadow: "0 12px 30px rgba(0,0,0,0.12)",
            }}
          >
            <div>
              <h1 style={{ marginBottom: "0.35rem" }}>The Beer Game</h1>
              <p style={{ maxWidth: "600px", marginTop: 0 }}>
                If you are the host, please click on <strong>Host the Game</strong>. If you
                are a student, please click on <strong>Join the Game</strong>.
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
            <button onClick={() => setView("home")}>Back</button>
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
            <button onClick={() => setView("home")}>Back</button>
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
            <button onClick={() => setView("home")}>Back</button>
            <PlayerView />
          </div>
        )}
      </div>
    </div>
  );
};

export default App;

