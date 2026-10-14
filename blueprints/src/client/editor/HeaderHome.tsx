// The left end of the editor's gold band: the Kilowatt Events logo (the
// black files: the band is gold in both themes) and the way back to the
// event plans. The lockup shows where there's room for it, the bulb on its
// own otherwise — CSS shows one or the other, never both (docs/BRAND.md).

import { Link } from "../router";
import Logo from "../ui/Logo";
import { IconArrowLeft } from "../ui/icons";

export default function HeaderHome() {
  return (
    <>
      <span className="ed-logo">
        <Logo variant="lockup" tone="on-gold" height={28} />
        <Logo variant="bulb" tone="on-gold" height={30} />
      </span>
      <Link to="/" className="ed-back" title="Back to event plans">
        <IconArrowLeft size={15} />
        <span className="ed-back-lbl">Plans</span>
      </Link>
    </>
  );
}
