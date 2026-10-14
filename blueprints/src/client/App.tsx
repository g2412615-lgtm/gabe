import { useEffect } from "react";
import { useRoute, Link } from "./router";
import HomePage from "./home/HomePage";
import EditorPage from "./editor/EditorPage";
import LoginPage from "./auth/LoginPage";
import AppHeader from "./ui/AppHeader";
import EmptyArt from "./ui/EmptyArt";
import Toaster from "./ui/Toaster";
import { APP_NAME } from "../shared/constants";

export default function App() {
  const route = useRoute();

  useEffect(() => {
    if (route.name !== "plan") document.title = route.name === "login" ? `Sign in · ${APP_NAME}` : APP_NAME;
  }, [route]);

  return (
    <>
      {route.name === "home" && <HomePage />}
      {route.name === "plan" && <EditorPage key={route.planId} planId={route.planId} initialPageId={route.pageId} initialCircleId={route.circleId} />}
      {route.name === "login" && <LoginPage next={route.next} />}
      {route.name === "notFound" && (
        <>
          <AppHeader wide />
          <main className="page wide not-found">
            <div className="empty">
              <EmptyArt />
              <h1>Page not found</h1>
              <p>That address doesn't match anything here.</p>
              <div className="empty-actions">
                <Link to="/" className="btn primary">
                  Back to event plans
                </Link>
              </div>
            </div>
          </main>
        </>
      )}
      <Toaster />
    </>
  );
}
