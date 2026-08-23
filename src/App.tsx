import React, { useEffect, useMemo, useState } from "react";
import { User, onAuthStateChanged, sendEmailVerification, signOut } from "firebase/auth";
import { doc, onSnapshot } from "firebase/firestore";
import HostLobby from "./components/HostLobby";
import PlayerJoin from "./components/PlayerJoin";
import PlayerView from "./components/PlayerView";
import AuthPortal from "./components/AuthPortal";
import AdminDashboard from "./components/AdminDashboard";
import titleBg from "./beergametitle.webp";
import { auth, db } from "./firebase";
import { ensureAdminProfile, syncEmailVerified, resumeClassPlayer } from "./api";
import { InstructorProfile } from "./types/auth";

// Classroom deep-link session keys — must match PlayerJoin / PlayerView.
const PLAYER_GAME_CODE_KEY = "beerGame_player_gameCode";
const PLAYER_ID_KEY = "beerGame_player_playerId";
const PLAYER_ROLE_KEY = "beerGame_player_role";
const PLAYER_TOKEN_KEY = "beerGame_player_sessionToken";

if (typeof document !== "undefined") {
  document.documentElement.style.setProperty(
    "--landing-hero-image",
    `url(${titleBg})`
  );
}

type View = "home" | "instructor" | "join" | "player";
type DashboardTab = "instructor" | "admin";
type AuthLandingMode = "login" | "register" | "reset";

const App: React.FC = () => {
  const [view, setView] = useState<View>("home");
  const [classResume, setClassResume] = useState<"idle" | "loading" | "error">("idle");
  const [authLandingMode, setAuthLandingMode] = useState<AuthLandingMode>("login");
  const [dashboardTab, setDashboardTab] = useState<DashboardTab>("instructor");
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [profile, setProfile] = useState<InstructorProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [verifyMessage, setVerifyMessage] = useState<string | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  // Classroom deep-link entry: a student arrives at /?class=<gameCode>&sid=<studentId>.
  // Exchange the studentId for the pre-assigned seat and drop straight into PlayerView.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const rawCode = params.get("class");
    const studentId = params.get("sid");
    if (!rawCode || !studentId) return;
    const gameCode = rawCode.trim().toUpperCase();
    setClassResume("loading");
    (async () => {
      try {
        const seat = await resumeClassPlayer({ gameCode, studentId });
        sessionStorage.setItem(PLAYER_GAME_CODE_KEY, gameCode);
        sessionStorage.setItem(PLAYER_ID_KEY, seat.playerId);
        sessionStorage.setItem(PLAYER_ROLE_KEY, seat.role ?? "pending");
        sessionStorage.setItem(PLAYER_TOKEN_KEY, seat.sessionToken);
        window.history.replaceState({}, "", window.location.pathname);
        setView("player");
        setClassResume("idle");
      } catch (err) {
        if (import.meta.env.DEV) console.error("resumeClassPlayer failed", err);
        setClassResume("error");
      }
    })();
  }, []);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser);
      setAuthLoading(false);
      if (!nextUser || nextUser.isAnonymous) {
        setProfile(null);
        setProfileLoading(false);
      } else {
        setProfileLoading(true);
      }
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (!user || user.isAnonymous) {
      return;
    }

    let cancelled = false;

    ensureAdminProfile().catch((err) => {
      if (import.meta.env.DEV) console.error("ensureAdminProfile failed", err);
      if (!cancelled) setProfileError("Failed to initialize instructor profile. Please reload the page.");
    });

    const ref = doc(db, "instructors", user.uid);
    const unsub = onSnapshot(
      ref,
      (snap) => {
        if (cancelled) {
          return;
        }
        if (!snap.exists()) {
          setProfile(null);
          setProfileLoading(false);
          return;
        }
        setProfile(snap.data() as InstructorProfile);
        setProfileLoading(false);
      },
      (err) => {
        if (import.meta.env.DEV) console.error(err);
        if (!cancelled) {
          setProfile(null);
          setProfileLoading(false);
        }
      }
    );

    return () => {
      cancelled = true;
      unsub();
    };
  }, [user]);

  const needsEmailVerification = profile?.emailVerified === false;

  useEffect(() => {
    if (!user || !needsEmailVerification || !user.emailVerified) {
      return;
    }
    syncEmailVerified().catch((err) => {
      if (import.meta.env.DEV) console.error("syncEmailVerified failed", err);
    });
  }, [user, needsEmailVerification]);

  const onCheckVerified = async () => {
    if (!auth.currentUser) {
      return;
    }
    setVerifyBusy(true);
    setVerifyError(null);
    setVerifyMessage(null);
    try {
      await auth.currentUser.reload();
      const refreshed = auth.currentUser;
      setUser(refreshed);
      if (refreshed?.emailVerified) {
        await syncEmailVerified();
        setVerifyMessage("Email verified. Your application is now visible to admins for review.");
      } else {
        setVerifyError("Email is not verified yet. Please click the link in the verification email.");
      }
    } catch (err) {
      if (import.meta.env.DEV) console.error(err);
      setVerifyError("Unable to refresh verification status. Try again in a moment.");
    } finally {
      setVerifyBusy(false);
    }
  };

  const onResendVerification = async () => {
    if (!auth.currentUser) {
      return;
    }
    setVerifyBusy(true);
    setVerifyError(null);
    setVerifyMessage(null);
    try {
      await sendEmailVerification(auth.currentUser);
      setVerifyMessage("Verification email resent. Check your inbox (and spam folder).");
    } catch (err) {
      if (import.meta.env.DEV) console.error(err);
      setVerifyError("Unable to resend verification email. Try again in a moment.");
    } finally {
      setVerifyBusy(false);
    }
  };

  const isApproved = profile?.status === "approved";
  const isAdmin = isApproved && profile?.role === "admin";
  const activeDashboardTab: DashboardTab = isAdmin ? dashboardTab : "instructor";

  const authSection = useMemo(() => {
    if (authLoading || profileLoading) {
      return <div className="panel">Loading account...</div>;
    }

    if (profileError) {
      return (
        <div className="panel">
          <div className="alert alert-error">{profileError}</div>
        </div>
      );
    }

    if (!user || user.isAnonymous) {
      return <AuthPortal initialMode={authLandingMode} />;
    }

    if (!profile) {
      return (
        <div className="panel">
          <h2>Account profile missing</h2>
          <p>
            This account is authenticated but does not have an instructor profile yet. Register as
            a new instructor from this screen or sign out and use a different account.
          </p>
          <button className="btn-subtle" onClick={() => signOut(auth)}>
            Sign out
          </button>
        </div>
      );
    }

    if (needsEmailVerification && !user.emailVerified) {
      return (
        <div className="panel dashboard-stack">
          <div className="section-header">
            <h2>Verify your email</h2>
            <span className="chip chip-pending">unverified</span>
          </div>
          <p>
            We sent a verification link to <strong>{profile.email}</strong>. Click that link to
            confirm your email address. Your application will not be reviewed until your email is
            verified.
          </p>
          <div className="actions-row">
            <button
              type="button"
              className="btn-primary"
              disabled={verifyBusy}
              onClick={onCheckVerified}
            >
              {verifyBusy ? "Checking..." : "I've verified my email"}
            </button>
            <button
              type="button"
              className="btn-subtle"
              disabled={verifyBusy}
              onClick={onResendVerification}
            >
              Resend verification email
            </button>
            <button
              type="button"
              className="btn-subtle"
              disabled={verifyBusy}
              onClick={() => signOut(auth)}
            >
              Sign out
            </button>
          </div>
          <div aria-live="polite">
            {verifyError && <div className="alert alert-error">{verifyError}</div>}
            {verifyMessage && <div className="alert alert-success">{verifyMessage}</div>}
          </div>
        </div>
      );
    }

    if (!isApproved) {
      return (
        <div className="panel dashboard-stack">
          <div className="section-header">
            <h2>Application status</h2>
            <span className={`chip chip-${profile.status}`}>{profile.status}</span>
          </div>
          {profile.status === "pending" && (
            <p>
              Your instructor request is pending admin review. You can stay signed in and refresh
              this page later.
            </p>
          )}
          {profile.status === "rejected" && (
            <p>Your instructor request was rejected. Contact the admin for details.</p>
          )}
          {profile.status === "revoked" && (
            <p>Your instructor access has been revoked by the admin.</p>
          )}
          <div>
            <button className="btn-subtle" onClick={() => signOut(auth)}>
              Sign out
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="dashboard-stack">
        <div className="panel identity-row">
          <div>
            Signed in as <strong>{profile.email}</strong>{" "}
            <span className="chip chip-neutral">{profile.role}</span>
          </div>
          <button className="btn-subtle" onClick={() => signOut(auth)}>
            Sign out
          </button>
        </div>

        {isAdmin && (
          <div className="tab-row" role="tablist" aria-label="Dashboard sections">
            {activeDashboardTab === "instructor" ? (
              <button
                type="button"
                className="tab-btn"
                role="tab"
                aria-selected="true"
                onClick={() => setDashboardTab("instructor")}
              >
                Instructor Console
              </button>
            ) : (
              <button
                type="button"
                className="tab-btn"
                role="tab"
                aria-selected="false"
                onClick={() => setDashboardTab("instructor")}
              >
                Instructor Console
              </button>
            )}
            {activeDashboardTab === "admin" ? (
              <button
                type="button"
                className="tab-btn"
                role="tab"
                aria-selected="true"
                onClick={() => setDashboardTab("admin")}
              >
                Admin Review
              </button>
            ) : (
              <button
                type="button"
                className="tab-btn"
                role="tab"
                aria-selected="false"
                onClick={() => setDashboardTab("admin")}
              >
                Admin Review
              </button>
            )}
          </div>
        )}

        {activeDashboardTab === "instructor" && (
          <HostLobby
            userUid={user.uid}
            instructorEmail={profile.email}
            isAdmin={Boolean(isAdmin)}
          />
        )}

        {isAdmin && activeDashboardTab === "admin" && <AdminDashboard />}
      </div>
    );
  }, [
    activeDashboardTab,
    authLoading,
    authLandingMode,
    isAdmin,
    isApproved,
    needsEmailVerification,
    profile,
    profileError,
    profileLoading,
    user,
    verifyBusy,
    verifyError,
    verifyMessage,
  ]);

  if (classResume !== "idle") {
    return (
      <div className="app-shell">
        <div className="app-frame">
          <div className="panel">
            {classResume === "loading" ? (
              <>
                <h2>Joining your game…</h2>
                <p>Taking you to your seat.</p>
              </>
            ) : (
              <>
                <div className="alert alert-error">
                  We couldn't find your seat for this session. Your instructor may not have started
                  the game yet, or the link is for a different class.
                </div>
                <button className="btn-subtle" onClick={() => setClassResume("idle")}>
                  Continue to home
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <div className="app-frame">
        {view === "home" && (
          <div className="hero-panel landing-hero">
            <div className="landing-topbar">
              <button
                className="btn-subtle landing-top-request"
                onClick={() => {
                  setAuthLandingMode("register");
                  setView("instructor");
                }}
              >
                Request Instructor Access
              </button>
            </div>

            <div className="landing-header">
              <h1 className="landing-title">The Beer Game</h1>
              <p className="text-muted landing-subtitle">
                Run multi-week supply chain rounds with live teams. Students join with a session
                code. Instructors create and control game sessions.
              </p>
            </div>

            <div className="landing-role-grid">
              <article className="landing-role-card">
                <h3>Students / Players</h3>
                <p>Have your session code ready, then join your team and role when prompted.</p>
                <div className="landing-role-action">
                  <button className="btn-primary landing-btn" onClick={() => setView("join")}>
                    Join Game
                  </button>
                </div>
              </article>
              <article className="landing-role-card">
                <h3>Instructors / Admin</h3>
                <p>Create sessions, assign teams, monitor rounds, and review instructor access.</p>
                <div className="landing-role-action">
                  <button
                    className="btn-primary landing-btn"
                    onClick={() => {
                      setAuthLandingMode("login");
                      setView("instructor");
                    }}
                  >
                    Instructor / Admin
                  </button>
                </div>
              </article>
            </div>
          </div>
        )}

        {view === "instructor" && (
          <div className="dashboard-stack">
            <div>
              <button className="btn-subtle" onClick={() => setView("home")}>
                Back
              </button>
            </div>
            {authSection}
          </div>
        )}

        {view === "join" && (
          <div className="dashboard-stack">
            <div>
              <button className="btn-subtle" onClick={() => setView("home")}>
                Back
              </button>
            </div>
            <PlayerJoin
              onJoined={() => {
                setView("player");
              }}
            />
          </div>
        )}

        {view === "player" && <PlayerView />}
      </div>
    </div>
  );
};

export default App;
