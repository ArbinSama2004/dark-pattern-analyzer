import { describe, expect, it, afterEach } from "vitest";
import { inferRole } from "./role";
import { ROLES } from "../roles";

afterEach(() => {
  document.body.innerHTML = "";
});

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body.firstElementChild as HTMLElement;
}

describe("inferRole", () => {
  it("always returns a member of the real role vocabulary", () => {
    const el = mount("<span>Some random UI copy</span>");
    const role = inferRole(el, "en");
    expect(ROLES).toContain(role);
  });

  it("infers checkbox structurally, regardless of label wording", () => {
    const el = mount('<input type="checkbox" />');
    expect(inferRole(el, "en")).toBe("checkbox");
  });

  it("infers heading from tag name", () => {
    const el = mount("<h2>Limited time offer</h2>");
    expect(inferRole(el, "en")).toBe("heading");
  });

  it("infers decline from English keyword", () => {
    const el = mount("<button>No thanks</button>");
    expect(inferRole(el, "en")).toBe("decline");
  });

  it("infers decline from Nepali keyword", () => {
    const el = mount("<button>रद्द गर्नुहोस्</button>");
    expect(inferRole(el, "ne")).toBe("decline");
  });

  it("infers cta from English keyword", () => {
    const el = mount("<button>Add to cart</button>");
    expect(inferRole(el, "en")).toBe("cta");
  });

  it("infers support_link from a mailto href", () => {
    const el = mount('<a href="mailto:help@example.com">Reach out</a>');
    expect(inferRole(el, "en")).toBe("support_link");
  });

  it("infers nav from tag name", () => {
    const el = mount("<nav>Main menu</nav>");
    expect(inferRole(el, "en")).toBe("nav");
  });

  it("infers fine_print from a disclaimer class", () => {
    const el = mount('<p class="disclaimer">Terms apply</p>');
    expect(inferRole(el, "en")).toBe("fine_print");
  });

  it("falls back to body when nothing matches", () => {
    const el = mount("<p>Free shipping on all orders</p>");
    expect(inferRole(el, "en")).toBe("body");
  });
});

describe("inferRole button narrowing (Fix 4, Part A)", () => {
  // Positive cases -- these must still resolve to "cta". The model-facing
  // vocabulary is unchanged throughout this suite: every case asserts one of
  // the existing 20 roles, never a new one.

  it("primary CTA button: matches an explicit keyword", () => {
    const el = mount("<button>Get Started</button>");
    expect(inferRole(el, "en")).toBe("cta");
  });

  it("submit buttons: type=submit is cta even with unrecognised wording", () => {
    const el = mount('<button type="submit">Apply</button>');
    expect(inferRole(el, "en")).toBe("cta");
  });

  it("buttons inside forms: an unclassified plain button still defaults to cta", () => {
    mount("<form><button>Redeem</button></form>");
    const el = document.querySelector("button") as HTMLElement;
    expect(inferRole(el, "en")).toBe("cta");
  });

  it("an unclassified plain button with no other signal still defaults to cta", () => {
    const el = mount("<button>Order Now</button>");
    expect(inferRole(el, "en")).toBe("cta");
  });

  // Negative cases -- structurally a button, but not an accept-side CTA.
  // All must fall through to something other than "cta" (body, in every
  // case here, since none of them also matches a more specific role).

  it("navigation button: a hamburger/menu opener is not cta", () => {
    const el = mount('<button aria-label="Open menu" aria-haspopup="true">☰</button>');
    expect(inferRole(el, "en")).not.toBe("cta");
  });

  it("close button: bare 'close' text is not cta", () => {
    const el = mount('<button aria-label="Close">×</button>');
    expect(inferRole(el, "en")).not.toBe("cta");
  });

  it("expand/collapse: aria-expanded marks a toggle, not cta", () => {
    const el = mount('<button aria-expanded="false">Details</button>');
    expect(inferRole(el, "en")).not.toBe("cta");
  });

  it("expand/collapse: an accordion class is not cta", () => {
    const el = mount('<button class="accordion-toggle">More</button>');
    expect(inferRole(el, "en")).not.toBe("cta");
  });

  it("quantity controls: an increment stepper is not cta", () => {
    const el = mount('<button aria-label="Increase quantity">+</button>');
    expect(inferRole(el, "en")).not.toBe("cta");
  });

  it("filter/sort controls: a filter toggle is not cta", () => {
    const el = mount('<button class="filter-toggle">Filter</button>');
    expect(inferRole(el, "en")).not.toBe("cta");
  });

  it("filter/sort controls: a sort control is not cta", () => {
    const el = mount('<button aria-label="Sort by price">Sort</button>');
    expect(inferRole(el, "en")).not.toBe("cta");
  });

  it("carousel controls: a slider-next arrow is not cta", () => {
    const el = mount('<button class="carousel-next" aria-label="Next slide">›</button>');
    expect(inferRole(el, "en")).not.toBe("cta");
  });

  it("pagination controls: a next-page button is not cta", () => {
    const el = mount('<button aria-label="Next page">›</button>');
    expect(inferRole(el, "en")).not.toBe("cta");
  });

  it("negative cases still return a member of the real role vocabulary", () => {
    const el = mount('<button aria-label="Close">×</button>');
    expect(ROLES).toContain(inferRole(el, "en"));
  });
});

describe("inferRole discount detection", () => {
  it("infers promo from an isolated discount badge", () => {
    const el = mount("<span>-54%</span>");
    expect(inferRole(el, "en")).toBe("promo");
  });

  it("infers promo from a discount joined with the price in one text node", () => {
    // Regression test: a live-page trace caught this exact string ("Rs.
    // 2,499 -54%") falling through to role=body while an isolated "-54%"
    // elsewhere on the same page correctly got role=promo -- same discount,
    // different markup shape, different (and inconsistent) role.
    const el = mount("<div>Rs. 2,499 -54%</div>");
    expect(inferRole(el, "en")).toBe("promo");
  });

  it("infers promo from '15% off' phrasing", () => {
    const el = mount("<span>15% off</span>");
    expect(inferRole(el, "en")).toBe("promo");
  });

  it("does not misfire on an ordinary negative number that isn't a discount", () => {
    const el = mount("<p>Temperature dropped to -5 degrees overnight</p>");
    expect(inferRole(el, "en")).not.toBe("promo");
  });

  it("still infers promo when adjacent spans have no separating whitespace in the DOM", () => {
    // The actual live-page bug: extract.ts's leafBlockText() joins "Rs.
    // 1,500" and "-33%" with an inserted space when it builds candidateText
    // -- but el.textContent has no space at all here (no text node between
    // the two spans), so inferRole() recomputing text straight from the
    // element sees "rs. 1,500-33%": a digit immediately before "-33%",
    // which the discount pattern correctly refuses to match (that's not a
    // discount token, it's a run-on number). Passing extract.ts's already-
    // correctly-joined candidateText is what fixes this.
    const el = mount("<div><span>Rs. 1,500</span><span>-33%</span></div>");
    expect(el.textContent).toBe("Rs. 1,500-33%"); // sanity: no space in the raw DOM
    expect(inferRole(el, "en")).not.toBe("promo"); // without the fix, using raw textContent
    expect(inferRole(el, "en", "Rs. 1,500 -33%")).toBe("promo"); // with extract.ts's joined text
  });
});

describe("inferRole timer detection vs. video player duration/progress", () => {
  it("infers timer from a bare MM:SS string outside any video context", () => {
    const el = mount("<span>02:15</span>");
    expect(inferRole(el, "en")).toBe("timer");
  });

  it("does not infer timer from a duration label inside a video player container", () => {
    // Regression test: a real trace on an Amazon product-videos carousel
    // caught every single false_urgency finding on the page (12 of them)
    // being a video duration/progress label, not a countdown -- role=timer
    // told the model "treat this MM:SS as urgency" regardless of context.
    document.body.innerHTML = `
      <div class="video-player">
        <video></video>
        <p id="duration">0:35</p>
      </div>
    `;
    const el = document.getElementById("duration") as HTMLElement;
    expect(inferRole(el, "en")).not.toBe("timer");
  });

  it("does not infer timer from a 'Remaining Time' readout next to a <video> element", () => {
    document.body.innerHTML = `
      <div id="player">
        <video></video>
        <div id="remaining">Remaining Time - 0:00</div>
      </div>
    `;
    const el = document.getElementById("remaining") as HTMLElement;
    expect(inferRole(el, "en")).not.toBe("timer");
  });

  it("does not infer timer next to a vendor player's own class naming (vjs-, plyr, ytp-)", () => {
    document.body.innerHTML = `<div class="vjs-remaining-time"><span id="t">1:04</span></div>`;
    const el = document.getElementById("t") as HTMLElement;
    expect(inferRole(el, "en")).not.toBe("timer");
  });

  it("still infers timer for a genuine countdown near unrelated video-flavoured wording", () => {
    // Narrow exclusion, not "any page with a video on it loses timer
    // detection everywhere" -- a real countdown sitting outside the actual
    // player container/class scope must still be caught.
    document.body.innerHTML = `
      <div id="page">
        <p>Watch our product video below</p>
        <div class="countdown-banner"><span id="timer">00:05:59</span></div>
      </div>
    `;
    const el = document.getElementById("timer") as HTMLElement;
    expect(inferRole(el, "en")).toBe("timer");
  });
});
