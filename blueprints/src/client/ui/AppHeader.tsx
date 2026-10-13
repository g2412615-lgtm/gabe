// The top bar on the home page: the brand on the left, the account menu on
// the right. Sticky and translucent like DeployMap's; it pads itself for the
// iPad status bar when the app runs from the home screen.

import type { ReactNode } from "react";
import { api, ApiError } from "../api";
import { Link, navigate } from "../router";
import { APP_NAME } from "../../shared/constants";
import BrandMark from "./BrandMark";
import Menu from "./Menu";
import { IconLogout, IconUser } from "./icons";
import { notify } from "./notify";

export async function signOut() {
  try {
    await api.logout();
  } catch (err) {
    // already signed out is fine; anything else means the cookie is still set
    if (!(err instanceof ApiError && err.status === 401)) {
      notify("You're still signed in — check the connection and try again.", "error");
      return;
    }
  }
  navigate("/login", { replace: true });
}

export default function AppHeader({ wide = true, children }: { wide?: boolean; children?: ReactNode }) {
  return (
    <header className={`app-header${wide ? " wide" : ""}`}>
      <div className="app-header-in">
        <Link className="brand" to="/">
          <BrandMark />
          <span className="brand-name">{APP_NAME}</span>
        </Link>
        <div className="header-right">
          {children}
          <Menu
            label={<IconUser size={16} />}
            ariaLabel="Account"
            title="Account"
            buttonClassName="avatar"
            align="right"
            items={[
              { heading: APP_NAME, sub: "Signed in on this device" },
              { label: "Sign out", icon: <IconLogout size={15} />, onSelect: () => void signOut() },
            ]}
          />
        </div>
      </div>
    </header>
  );
}
