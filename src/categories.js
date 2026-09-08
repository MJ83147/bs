// Item categories for member requests. Hardcoded on purpose (built with tools/categorize.html).
export const ITEM_CATEGORIES = {
  xanax: [206],
  otherdrugs: [196, 197, 198, 870, 199, 200, 201, 203, 204, 205],
  ecans: [987, 986, 985, 530, 532, 554, 553, 533, 555],
  med: [733, 732, 737, 736, 735, 734, 739, 738, 67, 66, 68, 797],
  fhc: [367],
  temps: [1456, 581, 394, 229, 1042, 463, 246, 222, 1294, 220, 242, 464, 742, 840, 847, 239, 1178, 392, 1054, 465, 226, 611, 221, 256, 257, 616, 814, 1205],
  wrongblood: [1012, 1363, 380],
};

export const CATEGORY_LABELS = {
  xanax: 'Xanax',
  otherdrugs: 'Other drugs',
  ecans: 'Ecans',
  med: 'Med kits',
  fhc: 'FHCs',
  temps: 'Temps',
  wrongblood: 'Wrong blood bag / ipecac',
};

// single  = one fixed item, no picking
// bucket  = any item in the group; banker sends whatever, matched by category
// specific = member picks the exact item from the group
export const CATEGORY_MODE = {
  xanax: 'single',
  fhc: 'single',
  ecans: 'bucket',
  wrongblood: 'bucket',
  med: 'specific',
  temps: 'specific',
  otherdrugs: 'specific',
};

// Requesting any of these while having an unused one open, with no attacks since, auto-declines.
export const ENERGY_CATEGORIES = ['xanax', 'fhc', 'ecans'];

export const CATEGORY_KEYS = Object.keys(ITEM_CATEGORIES);

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
