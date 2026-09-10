// Item categories for member requests. Hardcoded on purpose (built with tools/categorize.html).
export const ITEM_CATEGORIES = {
  xanax: [206],
  otherdrugs: [196, 197, 198, 870, 199, 200, 201, 203, 204, 205],
  ecans: [987, 986, 985, 530, 532, 554, 553, 533, 555],
  med: [733, 732, 737, 736, 735, 734, 739, 738, 67, 66, 68, 797],
  fhc: [367],
  temps: [463, 222, 220, 242, 464, 742, 840, 392, 465, 226, 221, 256, 814],
  // Blood bags also appear under `med`; an item may belong to more than one category.
  wrongblood: [733, 732, 737, 736, 735, 734, 739, 738, 1012, 1363],
};

export const CATEGORY_LABELS = {
  xanax: 'Xanax',
  otherdrugs: 'Other drugs',
  ecans: 'Ecans',
  med: 'Med kits',
  fhc: 'FHCs',
  temps: 'Temps',
  wrongblood: 'Wrong blood bag / ipecac',
  energyrefill: 'Energy refill',
};

// single  = one fixed item, no picking
// bucket  = any item in the group; banker sends whatever, matched by category
// specific = member picks the exact item from the group
// cash     = no item at all; the banker sends a fixed cash amount (see CASH_CATEGORIES)
export const CATEGORY_MODE = {
  xanax: 'single',
  fhc: 'single',
  ecans: 'bucket',
  wrongblood: 'specific',
  med: 'specific',
  temps: 'specific',
  otherdrugs: 'specific',
  energyrefill: 'cash',
};

// Requesting any of these while having an unused one open, with no attacks since, auto-declines.
export const ENERGY_CATEGORIES = ['xanax', 'fhc', 'ecans'];

// Categories fulfilled by sending cash rather than an item. These have no entry in
// ITEM_CATEGORIES, so they are kept out of CATEGORY_KEYS (which drives the stock /
// category pages) and only surface in the request menu via REQUEST_CATEGORY_KEYS.
export const CASH_CATEGORIES = ['energyrefill'];
export const isCashCategory = (c) => CASH_CATEGORIES.includes(c);

export const CATEGORY_KEYS = Object.keys(ITEM_CATEGORIES);

// Categories a member can pick in /request: the item categories plus the cash ones.
export const REQUEST_CATEGORY_KEYS = [...CATEGORY_KEYS, ...CASH_CATEGORIES];

const ITEM_TO_CATEGORY = (() => {
  const m = {};
  for (const [cat, ids] of Object.entries(ITEM_CATEGORIES)) for (const id of ids) m[id] = cat;
  return m;
})();

export function categoryOfItem(itemId) {
  return ITEM_TO_CATEGORY[Number(itemId)] || null;
}

export function itemsInCategory(category) {
  return ITEM_CATEGORIES[category] || [];
}
