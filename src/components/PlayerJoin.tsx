import React, { useState } from "react";
import { FirebaseError } from "firebase/app";
import { joinOrResumePlayer } from "../api";

const PLAYER_GAME_CODE_KEY = "beerGame_player_gameCode";
const PLAYER_ID_KEY = "beerGame_player_playerId";
const PLAYER_ROLE_KEY = "beerGame_player_role";
const PLAYER_TOKEN_KEY = "beerGame_player_sessionToken";

interface PlayerJoinProps {
  onJoined: () => void;
}

const PlayerJoin: React.FC<PlayerJoinProps> = ({ onJoined }) => {
  const [gameCode, setGameCode] = useState("");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const codePreview = gameCode.trim().toUpperCase();
  const namePreview = name.trim();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const code = gameCode.trim().toUpperCase();
    const trimmedName = name.trim();
    if (!code) {
      setError("Please enter a session code.");
      return;
    }
    if (!trimmedName) {
      setError("Please enter your name.");
      return;
    }

    setLoading(true);
    try {
      const payload = await joinOrResumePlayer({ gameCode: code, name: trimmedName });
      sessionStorage.setItem(PLAYER_GAME_CODE_KEY, code);
      sessionStorage.setItem(PLAYER_ID_KEY, payload.playerId);
      sessionStorage.setItem(PLAYER_ROLE_KEY, payload.role ? payload.role : "pending");
      sessionStorage.setItem(PLAYER_TOKEN_KEY, payload.sessionToken);
      onJoined();
    } catch (err) {
      console.error(err);
      const fbErr = err as FirebaseError;
      const code = fbErr?.code ?? "";
      if (fbErr?.message?.includes("NAME_TAKEN") || code.includes("already-exists")) {
        setError("This name is already in use for this session. Please choose a different name.");
      } else if (code.includes("resource-exhausted")) {
        setError("This game is in progress and all seats are currently occupied.");
      } else if (code.includes("failed-precondition")) {
        setError("This session is not joinable (ended or expired).");
      } else if (code.includes("not-found")) {
        setError("No session with that code was found.");
      } else {
        setError("Failed to join session.");
      }
    } finally {
      setLoading(false);
    }
  };

  const handleCodeChange = (nextValue: string) => {
    const normalized = nextValue
      .toUpperCase()
      .replace(/\s+/g, "")
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 8);
    setGameCode(normalized);
  };

  return (
    <section className="panel join-portal">
      <div className="join-layout">
        <aside className="join-intro">
          <h2>Join a Game</h2>
          <p>
            Enter the session code shared by your instructor and the name you want your teammates
            to see.
          </p>
          <div className="join-steps">
            <div className="join-step">
              <span className="chip chip-neutral">Step 1</span>
              <span>Get the session code from your instructor.</span>
            </div>
            <div className="join-step">
              <span className="chip chip-neutral">Step 2</span>
              <span>Use any name you want, but remember it.</span>
            </div>
            <div className="join-step">
              <span className="chip chip-neutral">Step 3</span>
              <span>Wait for team assignment after joining.</span>
            </div>
          </div>
        </aside>

        <div className="join-form-panel">
          <form onSubmit={handleSubmit} className="join-form">
            <div className="field">
              <label htmlFor="join-session-code">Session code</label>
              <input
                id="join-session-code"
                className="input join-code-input"
                type="text"
                inputMode="text"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                value={gameCode}
                onChange={(e) => handleCodeChange(e.target.value)}
                placeholder="ABCD"
                required
              />
              <p className="field-help">4-8 uppercase characters (example: ABCD).</p>
            </div>

            <div className="field">
              <label htmlFor="join-player-name">Your name</label>
              <input
                id="join-player-name"
                className="input"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ava"
                autoComplete="nickname"
                maxLength={32}
                required
              />
            </div>

            {(codePreview || namePreview) && (
              <div className="join-preview">
                <div>
                  Session: <strong>{codePreview || "..."}</strong>
                </div>
                <div>
                  Name: <strong>{namePreview || "..."}</strong>
                </div>
              </div>
            )}

            <button
              className="btn-primary join-submit-btn"
              type="submit"
              disabled={loading || !codePreview || !namePreview}
            >
              {loading ? "Joining..." : "Join Game"}
            </button>
          </form>

          <div aria-live="polite">
            {error && <div className="alert alert-error">{error}</div>}
          </div>
        </div>
      </div>
    </section>
  );
};

export default PlayerJoin;
