import React, { useEffect, useMemo, useState } from "react";
import { User, onAuthStateChanged, signOut } from "firebase/auth";
import { doc, onSnapshot } from "firebase/firestore";
import HostLobby from "./components/HostLobby";
import PlayerJoin from "./components/PlayerJoin";
import PlayerView from "./components/PlayerView";
import AuthPortal from "./components/AuthPortal";
import AdminDashboard from "./components/AdminDashboard";
import titleBg from "./beergametitle.webp";
import { auth, db } from "./firebase";
import { ensureAdminProfile } from "./api";
import { InstructorProfile } from "./types/auth";

type View = "home" | "instructor" | "join" | "player";
type DashboardTab = "instructor" | "admin";
type AuthLandingMode = "login" | "register" | "reset";

const App: React.FC = () => {
  const [view, setView] = useState<View>("home");
  const [authLandingMode, setAuthLandingMode] = useState<AuthLandingMode>("login");
  const [dashboardTab, setDashboardTab] = useState<DashboardTab>("instructor");
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [profile, setProfile] = useState<InstructorProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser);
      setAuthLoading(false);
      if (!nextUser) {
        setProfile(null);
        setProfileLoading(false);
      } else {
        setProfileLoading(true);
      }
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (!user) {
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
          <p style={{ color: "#b91c1c" }}>{profileError}</p>
        </div>
      );
    }

    if (!user) {
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
            <button
              className="tab-btn"
              role="tab"
              aria-selected={activeDashboardTab === "instructor"}
              onClick={() => setDashboardTab("instructor")}
            >
              Instructor Console
            </button>
            <button
              className="tab-btn"
              role="tab"
              aria-selected={activeDashboardTab === "admin"}
              onClick={() => setDashboardTab("admin")}
            >
              Admin Review
            </button>
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
    profile,
    profileError,
    profileLoading,
    user,
  ]);

  return (
    <div className="app-shell">
      <div className="app-frame">
        {view === "home" && (
          <div
            className="hero-panel landing-hero"
            style={{
              backgroundImage: `linear-gradient(132deg, rgba(255,255,255,0.94), rgba(245,250,255,0.86)), url(${titleBg})`,
              backgroundSize: "cover",
              backgroundPosition: "center",
            }}
          >
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

        {view === "player" && (
          <div className="dashboard-stack">
            <div>
              <button className="btn-subtle" onClick={() => setView("home")}>
                Back
              </button>
            </div>
            <PlayerView />
          </div>
        )}
      </div>
    </div>
  );
};

export default App;
