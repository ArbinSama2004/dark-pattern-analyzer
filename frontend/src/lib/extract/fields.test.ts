import { afterEach, describe, expect, it } from "vitest";
import { findCardRoot, inferField, refineTitleWithinCard, type Field } from "./fields";

afterEach(() => {
  document.body.innerHTML = "";
});

function el(html: string, selector: string): Element {
  document.body.innerHTML = html;
  return document.querySelector(selector)!;
}

describe("inferField", () => {
  it("reads a discount before a price, since a percentage carries no currency", () => {
    expect(inferField(el(`<span id="a">-54%</span>`, "#a"), "-54%")).toBe("discount");
    expect(inferField(el(`<span id="a">54% off</span>`, "#a"), "54% off")).toBe("discount");
  });

  it("separates the struck price from the price the shopper pays", () => {
    const struck = el(
      `<div class="price"><s><span id="was">Rs. 2,499</span></s><span id="now">Rs. 1,199</span></div>`,
      "#was",
    );
    expect(inferField(struck, "Rs. 2,499")).toBe("strike_price");

    const now = document.querySelector("#now")!;
    expect(inferField(now, "Rs. 1,199")).toBe("price");
  });

  it("recognises currency across the storefronts this targets", () => {
    for (const text of ["Rs. 1,199", "NPR 1,199", "₹200", "$19.99"]) {
      expect(inferField(el(`<span id="a">${text}</span>`, "#a"), text)).toBe("price");
    }
  });

  it("identifies ratings, sale counts, stock warnings and shipping terms", () => {
    const cases: Array<[string, Field]> = [
      ["4.6 out of 5 stars", "rating"],
      ["958 sold", "sold_count"],
      ["Only 3 items left", "stock"],
      ["Free Delivery", "shipping"],
    ];
    for (const [text, field] of cases) {
      expect(inferField(el(`<span id="a">${text}</span>`, "#a"), text)).toBe(field);
    }
  });

  it("treats a heading as a title without needing a card", () => {
    // Product detail pages have no repeating cards to compare against, so the
    // heading tag is the only title evidence available there.
    expect(
      inferField(el(`<h1 id="a">Wireless Earbuds</h1>`, "#a"), "Wireless Earbuds"),
    ).toBe("title");
  });

  it("answers unknown rather than guessing", () => {
    // The honest answer for text this cannot identify. Rules treat `unknown`
    // as unrestricted, so a wrong guess here would silently disable them.
    expect(inferField(el(`<span id="a">Add to Cart</span>`, "#a"), "Add to Cart")).toBe(
      "unknown",
    );
  });
});

describe("findCardRoot", () => {
  it("finds the repeating unit a product sits in", () => {
    const target = el(
      `<div class="grid">
         <div class="card"><span class="t" id="one">Product One</span></div>
         <div class="card"><span class="t">Product Two</span></div>
       </div>`,
      "#one",
    );

    expect((findCardRoot(target) as HTMLElement).className).toBe("card");
  });

  it("still matches cards carrying per-item modifier classes", () => {
    // Storefronts append modifiers (--sponsored, --sold-out) to otherwise
    // identical cards; an exact className comparison sees every card as
    // unique and finds no repetition at all.
    const target = el(
      `<div class="grid">
         <div class="card sponsored"><span id="one">Product One</span></div>
         <div class="card"><span>Product Two</span></div>
       </div>`,
      "#one",
    );

    expect(findCardRoot(target)).not.toBeNull();
  });

  it("returns null on a product detail page, where nothing repeats", () => {
    const target = el(
      `<main><section class="detail"><h1 id="one">Wireless Earbuds</h1></section></main>`,
      "#one",
    );

    expect(findCardRoot(target)).toBeNull();
  });
});

describe("refineTitleWithinCard", () => {
  it("picks the longest unknown text inside the card's own link", () => {
    document.body.innerHTML = `
      <div class="card">
        <a href="/p/1"><span id="brand">Nike</span><span id="name">Wireless Earbuds Pro Max</span></a>
        <span id="price">Rs. 1,199</span>
      </div>`;
    const card = document.querySelector(".card")!;
    const entries = [
      { el: document.querySelector("#brand")!, text: "Nike", field: "unknown" as Field },
      {
        el: document.querySelector("#name")!,
        text: "Wireless Earbuds Pro Max",
        field: "unknown" as Field,
      },
      { el: document.querySelector("#price")!, text: "Rs. 1,199", field: "price" as Field },
    ];

    refineTitleWithinCard(entries, card);

    expect(entries[1]!.field).toBe("title");
    expect(entries[0]!.field).toBe("unknown");
  });

  it("does not type a category nav link as a product title", () => {
    // Measured on a real Jeevee page: 14 category links ("Skin", "Medicines")
    // and several footer policy links were typed `title` purely because they
    // sat in a repeating container with a link. `title` suppresses rules, so a
    // wrong one silently disables detection wherever it lands. A block with no
    // price, discount, rating or sale count is not selling anything.
    document.body.innerHTML = `
      <div class="nav-tile"><img src="skin.png" alt=""><a href="/c/skin"><span id="cat">Skin Care Products</span></a></div>`;
    const card = document.querySelector(".nav-tile")!;
    const entries = [
      { el: document.querySelector("#cat")!, text: "Skin Care Products", field: "unknown" as Field },
    ];

    refineTitleWithinCard(entries, card);

    expect(entries[0]!.field).toBe("unknown");
  });

  it("never overwrites a field the text's own evidence already earned", () => {
    // A price inside the card's link is still a price, however long it is.
    document.body.innerHTML = `<div class="card"><a href="/p/1"><span id="p">Rs. 1,199</span></a><span>4.6 out of 5</span></div>`;
    const card = document.querySelector(".card")!;
    const entries = [
      { el: document.querySelector("#p")!, text: "Rs. 1,199", field: "price" as Field },
    ];

    refineTitleWithinCard(entries, card);

    expect(entries[0]!.field).toBe("price");
  });

  it("ignores text outside any link in the card", () => {
    document.body.innerHTML = `<div class="card"><span id="x">Some loose text here</span><span id="p">Rs. 999</span></div>`;
    const card = document.querySelector(".card")!;
    const entries = [
      { el: document.querySelector("#x")!, text: "Some loose text here", field: "unknown" as Field },
      { el: document.querySelector("#p")!, text: "Rs. 999", field: "price" as Field },
    ];

    refineTitleWithinCard(entries, card);

    expect(entries[0]!.field).toBe("unknown");
  });
});
