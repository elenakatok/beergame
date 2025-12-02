// src/components/PlayerJoin.tsx
import React, { useState } from "react";
import { db } from "../firebase";
import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  where,
  writeBatch,
} from "firebase/firestore";
import { ROLES } from "../logic/gameModel";

const PLAYER_GAME_CODE_KEY = "beerGame_player_gameCode";
const PLAYER_ID_KEY = "beerGame_player_playerId";
const PLAYER_ROLE_KEY = "beerGame_player_role";

interface PlayerJoinProps {
  onJoined: () => void;
}

const PlayerJoin: React.FC<PlayerJoinProps> = ({ onJoined }) => {
  const [gameCode, setGameCode] = useState("");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Please enter your name.");
      return;
    }

    const code = gameCode.trim().toUpperCase();
    if (!code) {
      setError("Please enter a game ID.");
      return;
    }

    setLoading(true);
    try {
      const gameRef = doc(db, "games", code);
      const gameSnap = await getDoc(gameRef);
      if (!gameSnap.exists()) {
        setError("No game with that ID was found.");
        setLoading(false);
        return;
      }
      const gameData = gameSnap.data() as any;
      const status = gameData.status as "lobby" | "in_progress" | "ended";

      const playersRef = collection(gameRef, "players");

      if (status === "lobby") {
        // Normal join before game starts: create a new player doc
        const playerDoc = await addDoc(playersRef, {
          name: trimmedName,
          createdAt: serverTimestamp(),
          teamId: null,
          role: null,
          isRobot: false,
        });

        localStorage.setItem(PLAYER_GAME_CODE_KEY, code);
        localStorage.setItem(PLAYER_ID_KEY, playerDoc.id);
        localStorage.setItem(PLAYER_ROLE_KEY, "pending");

        onJoined();
      } else if (status === "in_progress") {
        // Game already started: try to REATTACH this player by name first.
        const qPlayers = query(
          playersRef,
          where("name", "==", trimmedName)
        );
        const existingSnap = await getDocs(qPlayers);

        if (existingSnap.empty) {
          // No existing player with this name: try to replace a robot seat.
          const teamsRef = collection(gameRef, "teams");
          const teamsSnap = await getDocs(teamsRef);
          const robotSeats: {
            teamId: string;
            teamName: string | null;
            role: string;
            humanCount: number;
          }[] = [];

          teamsSnap.forEach((t) => {
            const data = t.data() as any;
            const stages = data.stages || {};
            const humanCount =
              typeof data.humanCount === "number" ? data.humanCount : 0;
            ROLES.forEach((role) => {
              const stage = stages[role];
              if (stage && stage.isRobot) {
                robotSeats.push({
                  teamId: t.id,
                  teamName: data.name ?? null,
                  role,
                  humanCount,
                });
              }
            });
          });

          if (robotSeats.length === 0) {
            setError(
              "This game is already in progress and all seats are taken. Please check with your instructor."
            );
            setLoading(false);
            return;
          }

          const seat =
            robotSeats[Math.floor(Math.random() * robotSeats.length)];

          const batch = writeBatch(db);
          const playerRef = doc(playersRef);
          batch.set(playerRef, {
            name: trimmedName,
            createdAt: serverTimestamp(),
            teamId: seat.teamId,
            role: seat.role,
            isRobot: false,
            teamName: seat.teamName,
          });

          const teamRef = doc(gameRef, "teams", seat.teamId);
          batch.update(teamRef, {
            [`stages.${seat.role}.playerId`]: playerRef.id,
            [`stages.${seat.role}.playerName`]: trimmedName,
            [`stages.${seat.role}.isRobot`]: false,
            humanCount: Math.max(0, seat.humanCount + 1),
          });

          await batch.commit();

          localStorage.setItem(PLAYER_GAME_CODE_KEY, code);
          localStorage.setItem(PLAYER_ID_KEY, playerRef.id);
          localStorage.setItem(PLAYER_ROLE_KEY, seat.role);

          onJoined();
          setLoading(false);
          return;
        }

        const existingDoc = existingSnap.docs[0];
        const pdata = existingDoc.data() as any;

        localStorage.setItem(PLAYER_GAME_CODE_KEY, code);
        localStorage.setItem(PLAYER_ID_KEY, existingDoc.id);
        localStorage.setItem(
          PLAYER_ROLE_KEY,
          pdata.role ? pdata.role : "pending"
        );

        onJoined();
      } else {
        // Game ended
        setError(
          "This game has already ended and cannot accept new players."
        );
      }
    } catch (err) {
      console.error(err);
      setError("Failed to join game.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ maxWidth: 480 }}>
      <h2>Join a Game</h2>
      <p>Enter the game ID from your instructor and your name.</p>
      <form
        onSubmit={handleSubmit}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "0.5rem",
          marginTop: "0.5rem",
        }}
      >
        <input
          type="text"
          value={gameCode}
          onChange={(e) => setGameCode(e.target.value)}
          placeholder="Game ID (e.g., ABCD)"
        />
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your name"
        />
        <button type="submit" disabled={loading}>
          {loading ? "Joining…" : "Join game"}
        </button>
        {error && (
          <div style={{ color: "red", fontSize: "0.9rem" }}>{error}</div>
        )}
      </form>
    </div>
  );
};

export default PlayerJoin;
