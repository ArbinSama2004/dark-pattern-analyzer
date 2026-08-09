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
