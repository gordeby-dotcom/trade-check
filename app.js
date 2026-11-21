"use strict";

const apiRoot = "https://api.tcgdex.net/v2/en/";
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const dateLabel = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });
const maxPriceAge = 30 * 24 * 60 * 60 * 1000;
const resultStep = 8;

const priceLabels = {
  normal: "Non-holo",
  holofoil: "Holofoil",
  "reverse-holofoil": "Reverse holo",
  "1st-edition": "1st Edition · Non-holo",
  "1st-edition-holofoil": "1st Edition · Holofoil",
  unlimited: "Unlimited · Non-holo",
  "unlimited-holofoil": "Unlimited · Holofoil",
};
const standardTypes = { normal: "normal", reverse: "reverse-holofoil", holo: "holofoil" };
const exampleCards = [
  {
    id: "sv03.5-025", name: "Pikachu", localId: "025", rarity: "Common", value: 0.8,
    hp: 60, attacks: [{ name: "Pika Punch", damage: 50, cost: ["Lightning", "Lightning", "Colorless"] }],
  },
  {
    id: "sv03.5-004", name: "Charmander", localId: "004", rarity: "Common", value: 0.72,
    hp: 70, attacks: [{ name: "Steady Firebreathing", damage: 30, cost: ["Fire", "Fire"] }],
  },
];

const sides = [
  { id: "give", title: "You give", description: "The card you’re trading away", icon: "out" },
  { id: "receive", title: "You get", description: "The card you’re getting back", icon: "in" },
];
const panels = document.querySelector("#panels");
const template = document.querySelector("#panel-template");
const verdict = document.querySelector("#verdict");
const battle = document.querySelector("#battle");
const battleResult = document.querySelector("#battle-result");
const actionNote = document.querySelector("#action-note");
const help = document.querySelector("#help-dialog");
const swapButton = iconButton("swap", "Swap the two cards", "swap-button");
const searchCache = new Map();
let setsPromise;
let demo = false;

function el(tag, className, label) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (label !== undefined) element.textContent = label;
  return element;
}

function icon(name) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  const use = document.createElementNS(ns, "use");
  use.setAttribute("href", "#i-" + name);
  svg.setAttribute("aria-hidden", "true");
  svg.append(use);
  return svg;
}

function iconButton(name, label, className) {
  const button = el("button", className);
  button.type = "button";
  button.setAttribute("aria-label", label);
  button.title = label;
  button.append(icon(name));
  return button;
}

function artwork(url, label = "", size = "low") {
  const frame = el("span", "artwork");
  frame.append(icon("brand"));
  if (!url) return frame;
  let source;
  try {
    source = new URL(url);
  } catch {
    return frame;
  }
  if (source.origin !== "https://assets.tcgdex.net") return frame;
  const img = el("img");
  img.alt = label;
  img.loading = "lazy";
  img.src = source.href + "/" + size + ".webp";
  img.addEventListener("error", () => img.remove(), { once: true });
  frame.append(img);
  return frame;
}

function getJSON(path, signal = AbortSignal.timeout(8500)) {
  return fetch(apiRoot + path, { signal }).then(response => {
    if (!response.ok) throw new Error("Catalog request failed");
    return response.json();
  });
}

function getSets() {
  setsPromise ??= getJSON("sets", AbortSignal.timeout(3500))
    .then(sets => new Map(sets.map(set => [set.id, set])))
    .catch(() => {
      setsPromise = undefined;
      return new Map();
    });
  return setsPromise;
}

function parseQuery(query) {
  const [name, number, total] = query.trim().match(/^(.*?)(?:\s*#([a-z]*\d+[a-z]*)(?:\/(\d+))?)?$/i).slice(1);
  return { name: name.trim(), number: normalizeNumber(number), total: normalizeNumber(total) };
}

function normalizeNumber(number) {
  return String(number ?? "").toUpperCase().replace(/^0+(?=\d)/, "");
}

function setId(card) {
  return card.id.slice(0, -(String(card.localId).length + 1));
}

function editionLabel(card, set) {
  // The catalog also has promo and gallery subsets without a printed denominator.
  const total = set?.cardCount?.official;
  const number = /^\d+$/.test(card.localId) && total > 1 ? card.localId + "/" + total : card.localId;
  return [set?.name ?? setId(card), "#" + number].join(" · ");
}

async function searchCards(query, signal) {
  const { name, number, total } = parseQuery(query);
  const searchKey = name.toLowerCase();
  const request = searchCache.has(searchKey)
    ? Promise.resolve(searchCache.get(searchKey))
    : getJSON("cards?" + new URLSearchParams({ name: "like:" + name }), signal);
  const [cards, sets] = await Promise.all([request, getSets()]);
  if (searchCache.size >= 35) searchCache.delete(searchCache.keys().next().value);
  searchCache.set(searchKey, cards);
  const rank = card => {
    const comparison = card.name.toLowerCase();
    return comparison === searchKey ? 0 : comparison.startsWith(searchKey) ? 1 : 2;
  };
  return cards.filter(card => {
    if (card.image?.includes("/tcgp/")) return false;
    if (number && normalizeNumber(card.localId) !== number) return false;
    const official = sets.get(setId(card))?.cardCount?.official;
    return !total || !official || normalizeNumber(official) === total;
  }).sort((a, b) => rank(a) - rank(b) || Number(Boolean(b.image)) - Number(Boolean(a.image)))
    .map(card => ({ ...card, set: sets.get(setId(card)) }));
}

function prettify(value) {
  const names = {
    "1st-edition": "1st Edition",
    "pokemon-together": "Pokémon Together",
    "gamestop": "GameStop",
    "eb-games": "EB Games",
    "w-promo": "W Promo",
    "1999-2000-copyright": "1999–2000 copyright",
  };
  return names[value] ?? value.replace(/-/g, " ").replace(/^./, character => character.toUpperCase());
}

function readPrice(feed, keys, productId) {
  if (feed?.unit !== "USD") return { value: null, updated: null };
  for (const key of keys) {
    const quote = feed[key];
    if (productId && String(quote?.productId) !== String(productId)) continue;
    if (Number.isFinite(quote?.marketPrice) && quote.marketPrice > 0) {
      return { value: quote.marketPrice, updated: feed.updated };
    }
  }
  return { value: null, updated: null };
}

function legacyPrintings(card) {
  const feed = card.pricing?.tcgplayer;
  const flags = card.variants ?? {};
  const keys = new Set(Object.keys(priceLabels).filter(key => feed?.[key]));
  if (feed?.reverse) keys.add("reverse-holofoil");
  for (const [flag, key] of Object.entries(standardTypes)) {
    if (flags[flag]) keys.add(key);
  }
  if (flags.firstEdition && flags.normal) keys.add("1st-edition");
  if (flags.firstEdition && flags.holo) keys.add("1st-edition-holofoil");

  const options = [...keys].map(key => ({
    label: priceLabels[key],
    ...readPrice(feed, key === "reverse-holofoil" ? [key, "reverse"] : [key]),
  }));
  if (flags.wPromo) options.push({ label: "W Promo stamp", value: null });
  return options;
}

function detailedPrinting(variant) {
  const { type, subtype, size, stamp = [], foil } = variant;
  const key = standardTypes[type];
  const firstEdition = stamp.includes("1st-edition") || subtype === "1st-edition";
  const suffix = type === "holo" ? "-holofoil" : "";
  const productId = variant.thirdParty?.tcgplayer;
  const keys = [];
  if (firstEdition && (type === "holo" || type === "normal")) keys.push("1st-edition" + suffix);
  if (subtype === "unlimited" && (type === "holo" || type === "normal")) keys.push("unlimited" + suffix);
  // Only use generic finish keys when the feed belongs to this exact printing.
  if (key && (!firstEdition || productId)) keys.push(key);
  if (type === "reverse" && (!firstEdition || productId)) keys.push("reverse");
  const label = [
    priceLabels[key] ?? prettify(type ?? "Printing"),
    subtype && !stamp.includes(subtype) ? prettify(subtype) : "",
    ...stamp.map(prettify),
    foil ? prettify(foil) : "",
    size && size !== "standard" ? prettify(size) : "",
  ].filter(Boolean).join(" · ");
  return { label, ...readPrice(variant.pricing?.tcgplayer, keys, productId) };
}

function getPrintings(card) {
  const detailed = card.variants_detailed?.filter(variant => variant.type && variant.variantId !== "generated");
  return detailed?.length ? detailed.map(detailedPrinting) : legacyPrintings(card);
}

function selectedQuote(side) {
  return side.finish === "" ? null : side.card?.printings[Number(side.finish)];
}

function isFresh(quote) {
  const time = Date.parse(quote.updated);
  const age = Date.now() - time;
  return Number.isFinite(age) && age >= -24 * 60 * 60 * 1000 && age <= maxPriceAge;
}

function renderQuote(side, parent) {
  const quote = selectedQuote(side);
  if (!quote) {
    if (side.card.printings.length) parent.append(el("p", "price-caption", "Choose a printing for its market value."));
    return;
  }
  if (quote.value == null) {
    parent.append(el("p", "price-caption", "No USD market price for this printing"));
    return;
  }
  parent.append(el("p", "price", money.format(quote.value) + " USD"));
  const updated = Date.parse(quote.updated);
  const caption = side.card.example ? "Example price · practice only"
    : Number.isFinite(updated) ? "Market value estimate · " + dateLabel.format(updated)
      : "Market value estimate · date unavailable";
  parent.append(el("p", "price-caption", caption));
}

function rarityBadge(rarity) {
  const label = rarity?.trim();
  const key = label?.toLowerCase();
  const hasRarity = key && !["none", "unknown", "n/a"].includes(key);
  const badge = el("p", "rarity-badge");
  if (hasRarity) {
    badge.classList.toggle("rarity-uncommon", key === "uncommon");
    badge.classList.toggle("rarity-special", key !== "common" && key !== "uncommon");
    badge.append(el("span", "rarity-label", "Rarity"), el("strong", "", label));
  } else {
    badge.textContent = "Rarity unavailable";
  }
  return badge;
}

function battleStats(card) {
  if (card.category !== "Pokemon") return null;
  let strongest = null;
  let variable = false;
  for (const attack of card.attacks ?? []) {
    const mark = String(attack.damage ?? "").trim();
    const isFixed = /^\d+$/.test(mark);
    const damage = isFixed ? Number(mark) : 0;
    if (!isFixed && /[\d?]/.test(mark)) variable = true;
    const energy = Array.isArray(attack.cost)
      ? attack.cost.filter(symbol => symbol && String(symbol).toLowerCase() !== "free").length
      : null;
    if (damage > 0 && (!strongest || damage > strongest.damage ||
      (damage === strongest.damage && (energy ?? Infinity) < (strongest.energy ?? Infinity)))) {
      strongest = { damage, name: attack.name, energy };
    }
  }
  return { hp: Number.isFinite(card.hp) && card.hp > 0 ? card.hp : null, strongest, variable };
}

function stat(label, value, description = "") {
  const item = el("div", "play-stat");
  item.append(el("dt", "", label), el("dd", "", value));
  if (description) item.append(el("dd", "stat-description", description));
  return item;
}

function playStats(card) {
  const stats = battleStats(card);
  if (!stats) {
    const role = el("div", "play-stats card-role");
    const category = { Trainer: "Trainer card", Energy: "Energy card" }[card.category] ?? "Game stats unavailable";
    role.append(el("p", "role-label", category));
    if (card.effect) {
      const effect = el("details");
      effect.append(el("summary", "", "Card effect"), el("p", "", card.effect));
      role.append(effect);
    }
    return role;
  }
  const { hp, strongest, variable } = stats;
  const attackValue = strongest ? String(strongest.damage) : variable ? "Varies" : "—";
  const attackName = strongest ? [strongest.name, strongest.energy === null ? "" : strongest.energy + " Energy"].filter(Boolean).join(" · ")
    : variable ? "Attack damage can change" : "No fixed damage listed";
  const list = el("dl", "play-stats");
  list.append(stat("HP", hp === null ? "—" : String(hp)), stat("Biggest fixed hit", attackValue, attackName));
  return list;
}

function compareBattle(give, receive) {
  const left = battleStats(give);
  const right = battleStats(receive);
  const limits = "Energy costs, abilities, matchups, and your deck can change which card plays better.";
  if (!left || !right) {
    return ["Compare what each card helps you do",
      "Trainer and Energy cards are judged by how they support your deck. The HP and attack comparison is for two Pokémon cards."];
  }

  const hpDelta = left.hp !== null && right.hp !== null ? left.hp - right.hp : null;
  const hitDelta = left.strongest && right.strongest ? left.strongest.damage - right.strongest.damage : null;
  const sameName = give.name === receive.name;
  const giveName = sameName ? "The " + give.name + " you give" : give.name;
  const receiveName = sameName ? "The " + receive.name + " you get" : receive.name;
  const hpLeader = hpDelta > 0 ? giveName : receiveName;
  const hitLeader = hitDelta > 0 ? giveName : receiveName;
  if (hpDelta === null || hitDelta === null) {
    const reason = hpDelta ? hpLeader + " has more HP. " : "";
    return ["No clear edge on printed stats",
      reason + "A card may have variable damage, an effect instead of a damage number, or incomplete stats. " + limits];
  }
  const variableNote = left.variable || right.variable ? " Some attacks have variable damage." : "";
  if (!hpDelta && !hitDelta) {
    return ["Even on printed stats", "Both have the same HP and biggest fixed hit." + variableNote + " " + limits];
  }
  if (hpDelta * hitDelta < 0) {
    return ["Different strengths", hpLeader + " has more HP. " + hitLeader +
      " has the bigger fixed hit." + variableNote + " " + limits];
  }
  const reason = hpDelta && hitDelta ? "It has more HP and a bigger fixed hit."
    : hpDelta ? "It has more HP, and their biggest fixed hits are equal."
      : "It has a bigger fixed hit, and their HP is equal.";
  return [(hpDelta ? hpLeader : hitLeader) + " has the edge on printed stats",
    reason + variableNote + " " + limits];
}

function renderBattle() {
  const [give, receive] = sides.map(side => side.card);
  battle.hidden = !give || !receive;
  if (battle.hidden) {
    battleResult.replaceChildren();
    return;
  }
  const [headline, detail] = compareBattle(give, receive);
  battleResult.replaceChildren(el("p", "battle-headline", headline), el("p", "battle-detail", detail));
}

function updateSwap() {
  swapButton.disabled = sides.some(side => side.loading) || sides.every(side => !side.card);
}

function renderCard(side) {
  const { stage, card } = side;
  stage.classList.toggle("has-card", Boolean(card));
  stage.replaceChildren();
  if (!card) {
    if (!side.loading && !side.error) stage.append(side.emptyArt.cloneNode(true));
    stage.append(el("p", "card-loading", side.loading ? "Looking up this printing…" : side.error || "No card selected"));
    updateSwap();
    return;
  }

  const details = el("div", "card-info");
  details.append(
    el("h3", "card-name", card.name),
    el("p", "card-edition", editionLabel(card, card.set)),
    rarityBadge(card.rarity),
  );

  if (card.printings.length) {
    const label = el("label", "finish-label", "Finish / printing");
    label.htmlFor = side.id + "-finish";
    const dropdown = el("select", "finish-select");
    dropdown.id = label.htmlFor;
    if (card.printings.length > 1) {
      const prompt = new Option("Choose your printing…", "");
      prompt.disabled = true;
      dropdown.add(prompt);
    }
    card.printings.forEach((printing, index) => dropdown.add(new Option(printing.label, String(index))));
    dropdown.value = side.finish;
    dropdown.addEventListener("change", () => {
      side.finish = dropdown.value;
      clearVerdict();
      price.replaceChildren();
      renderQuote(side, price);
    });
    details.append(label, dropdown);
  }
  const price = el("div", "quote");
  price.setAttribute("aria-live", "polite");
  if (!card.printings.length) price.append(el("p", "price-caption", "Market value unavailable."));
  renderQuote(side, price);
  details.append(price);
  stage.append(artwork(card.image, card.name + " card artwork", "high"), details, playStats(card));
  updateSwap();
}

function closeResults(side) {
  side.results.hidden = true;
  side.status.textContent = "";
}

function showMessage(side, message) {
  side.results.replaceChildren(el("p", "result-message", message));
  side.results.hidden = false;
  side.status.textContent = message;
}

function renderResults(side, append = false) {
  if (!append) side.results.replaceChildren();
  side.results.querySelector(".more-button")?.remove();
  const end = Math.min(side.cards.length, side.visible + resultStep);
  const buttons = side.cards.slice(side.visible, end).map(card => {
    const option = el("button", "result-button");
    option.type = "button";
    const details = el("span");
    details.append(el("strong", "", card.name), el("small", "", editionLabel(card, card.set)));
    option.append(artwork(card.image), details);
    option.addEventListener("click", () => selectCard(side, card));
    return option;
  });
  side.results.append(...buttons);
  side.visible = end;
  if (end < side.cards.length) {
    const more = el("button", "more-button", "Show more printings");
    more.type = "button";
    more.addEventListener("click", () => renderResults(side, true));
    side.results.append(more);
  }
  if (append) buttons[0]?.focus();
  side.results.hidden = false;
}

async function runSearch(side) {
  clearTimeout(side.timer);
  const query = side.input.value.trim();
  side.searchRequest?.abort();
  if (parseQuery(query).name.length < 2) {
    showMessage(side, "Enter at least two letters of the card name.");
    return;
  }
  const controller = new AbortController();
  side.searchRequest = controller;
  showMessage(side, "Searching for cards…");
  try {
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(8500)]);
    const cards = await searchCards(query, signal);
    if (controller.signal.aborted) return;
    side.cards = cards;
    side.visible = 0;
    if (!cards.length) {
      showMessage(side, "No cards found. Check the name or try without the number.");
      return;
    }
    renderResults(side);
    side.status.textContent = cards.length + (cards.length === 1 ? " printing found." : " printings found.") + " Match the set and card number.";
  } catch {
    if (!controller.signal.aborted) showMessage(side, "The catalog didn’t load. Try searching again.");
  }
}

function stopSearch(side) {
  clearTimeout(side.timer);
  side.searchRequest?.abort();
  closeResults(side);
}

function resetSide(side) {
  stopSearch(side);
  side.detailRequest?.abort();
  side.loading = false;
  side.error = "";
  side.card = null;
  side.finish = "";
}

function leaveExample() {
  if (!demo) return;
  demo = false;
  for (const side of sides) {
    resetSide(side);
    side.input.value = "";
    renderCard(side);
  }
  renderBattle();
}

async function selectCard(side, entry) {
  resetSide(side);
  clearVerdict();
  side.input.value = entry.name;
  side.input.focus();
  side.loading = true;
  renderCard(side);
  renderBattle();
  const controller = new AbortController();
  side.detailRequest = controller;
  try {
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(8500)]);
    const card = await getJSON("cards/" + encodeURIComponent(entry.id), signal);
    if (controller.signal.aborted) return;
    const printings = getPrintings(card);
    side.card = { ...card, printings };
    side.finish = printings.length === 1 ? "0" : "";
    side.status.textContent = "Selected " + card.name + ", " + editionLabel(card, card.set) + ".";
  } catch {
    if (controller.signal.aborted) return;
    side.error = "This printing didn’t load. Search again to retry.";
    side.status.textContent = side.error;
  }
  side.loading = false;
  renderCard(side);
  renderBattle();
}

function addPanel(side) {
  const panel = template.content.firstElementChild.cloneNode(true);
  panel.classList.add(side.id);
  panel.setAttribute("aria-labelledby", side.id + "-title");
  const title = panel.querySelector(".side-title");
  title.id = side.id + "-title";
  title.textContent = side.title;
  panel.querySelector(".side-description").textContent = side.description;
  panel.querySelector(".side-icon use").setAttribute("href", "#i-" + side.icon);
  side.form = panel.querySelector("form");
  side.form.setAttribute("aria-label", side.title);
  side.input = panel.querySelector("input");
  side.input.id = side.id + "-search";
  const label = panel.querySelector("label");
  label.htmlFor = side.input.id;
  label.textContent = side.title + " card name";
  side.results = panel.querySelector(".search-results");
  side.status = panel.querySelector(".search-status");
  side.stage = panel.querySelector(".card-stage");
  side.emptyArt = panel.querySelector(".stage-art").cloneNode(true);
  side.finish = "";
  panels.append(panel);

  side.input.addEventListener("input", () => {
    const query = side.input.value;
    leaveExample();
    resetSide(side);
    side.input.value = query;
    clearVerdict();
    renderCard(side);
    renderBattle();
    if (parseQuery(query).name.length >= 2) side.timer = setTimeout(() => runSearch(side), 270);
  });

  side.form.addEventListener("submit", event => {
    event.preventDefault();
    if (demo) {
      const query = side.input.value;
      leaveExample();
      side.input.value = query;
    }
    runSearch(side);
  });

  side.form.addEventListener("keydown", event => {
    if (side.results.hidden) return;
    if (event.key === "Escape") {
      event.preventDefault();
      stopSearch(side);
      side.input.focus();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const results = [...side.results.querySelectorAll("button")];
    if (!results.length) return;
    event.preventDefault();
    const index = results.indexOf(document.activeElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    const next = index === -1 ? (step === 1 ? 0 : results.length - 1) : index + step;
    (results[next] ?? side.input).focus();
  });

  side.form.addEventListener("focusout", event => {
    if (event.relatedTarget && !side.form.contains(event.relatedTarget)) stopSearch(side);
  });
}

function clearVerdict() {
  verdict.hidden = true;
  actionNote.textContent = "";
}

function showVerdict(title, description, meta, mood = "") {
  verdict.className = "verdict" + (mood ? " " + mood : "");
  const body = el("div", "verdict-content");
  const copy = el("div");
  const heading = el("h2", "", title);
  heading.id = "verdict-title";
  copy.append(heading, el("p", "", description), el("p", "verdict-meta", meta));
  body.append(icon(mood === "positive" ? "check" : mood === "caution" ? "info" : "scale"), copy);
  verdict.replaceChildren(body);
  verdict.hidden = false;
  verdict.focus({ preventScroll: true });
  verdict.scrollIntoView({ block: "nearest" });
}

function compare() {
  clearVerdict();
  const incomplete = sides.find(side => !side.card);
  if (incomplete) {
    actionNote.textContent = incomplete.loading ? "Wait for the card to finish loading." : "Find a card on each side to check your trade.";
    incomplete.input.focus();
    return;
  }
  const needsFinish = sides.find(side => side.card.printings.length > 1 && side.finish === "");
  if (needsFinish) {
    actionNote.textContent = "Choose the exact finish or printing for each card.";
    document.getElementById(needsFinish.id + "-finish").focus();
    return;
  }

  const [give, receive] = sides.map(selectedQuote);
  const meta = demo ? "Practice trade · example prices only" : "USD market estimates · assumes similar condition";
  if (give?.value == null || receive?.value == null) {
    showVerdict("Need both prices", "At least one printing has no USD market estimate. Look up sales for the exact printing before you trade.", meta, "caution");
    return;
  }
  if (!demo && (!isFresh(give) || !isFresh(receive))) {
    showVerdict("Check recent prices", "At least one price is over 30 days old or has no reliable update date. Look up recent sales before deciding.", meta, "caution");
    return;
  }

  const difference = Math.round((receive.value - give.value) * 100) / 100;
  const gap = money.format(Math.abs(difference));
  const margin = Math.max(0.25, Math.max(give.value, receive.value) * 0.10);
  if (Math.abs(difference) <= margin) {
    const detail = difference === 0 ? "Both cards have the same estimated value."
      : "The two estimates are " + gap + " apart.";
    showVerdict("About even", detail, meta);
  } else if (difference > 0) {
    showVerdict("You’re getting more value", "The card you’re getting is estimated at " + gap + " more than the one you’re giving.", meta, "positive");
  } else {
    showVerdict("You’re giving more value", "Your card is estimated at " + gap + " more. Consider asking for something extra or holding on to your card.", meta, "caution");
  }
}

function loadExample() {
  clearVerdict();
  demo = true;
  sides.forEach((side, index) => {
    resetSide(side);
    const example = exampleCards[index];
    side.card = {
      ...example,
      example: true,
      category: "Pokemon",
      set: { name: "151", cardCount: { official: 165 } },
      image: "https://assets.tcgdex.net/en/sv/sv03.5/" + example.localId,
      printings: [{ label: "Non-holo", value: example.value }],
    };
    side.input.value = example.name;
    side.finish = "0";
    renderCard(side);
  });
  renderBattle();
  compare();
}

function swap() {
  clearVerdict();
  sides.forEach(stopSearch);
  const [give, receive] = sides;
  [give.card, receive.card] = [receive.card, give.card];
  [give.finish, receive.finish] = [receive.finish, give.finish];
  for (const side of sides) {
    side.error = "";
    side.input.value = side.card?.name ?? "";
    renderCard(side);
  }
  renderBattle();
  actionNote.textContent = "Cards swapped.";
}

sides.forEach(addPanel);
panels.append(swapButton);
updateSwap();
swapButton.addEventListener("click", swap);
document.querySelector("#compare").addEventListener("click", compare);
document.querySelector("#example").addEventListener("click", loadExample);
document.querySelector("#help-button").addEventListener("click", () => help.showModal());
document.addEventListener("pointerdown", event => {
  for (const side of sides) {
    if (!side.form.contains(event.target)) stopSearch(side);
  }
});
