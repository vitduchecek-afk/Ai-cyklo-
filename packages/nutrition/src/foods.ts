/**
 * Built-in catalogue of common trail foods sold in CZ/SK/PL shops.
 *
 * All values are TYPICAL generic values for the product type (per 100 g scaled
 * to the package), NOT measured data of a specific brand. Prices are rough
 * 2025 CZK shop prices and are always estimates. Allergens of mixed products
 * are listed conservatively. Always check the label of the real product.
 */
import type { FoodItem, MealType } from '@trailpack/shared';

/** The 14 EU allergen groups (lower-case English keys used in `FoodItem.allergens`). */
export const EU_ALLERGENS = ['gluten', 'crustaceans', 'eggs', 'fish', 'peanuts', 'soy', 'milk', 'nuts', 'celery', 'mustard', 'sesame', 'sulphites', 'lupin', 'molluscs'] as const;
export type EuAllergen = (typeof EU_ALLERGENS)[number];

/** Czech notice shown wherever built-in values are displayed. */
export const BUILTIN_FOOD_NOTICE =
  'Hodnoty jsou typické pro daný druh potraviny, nikoli pro konkrétní výrobek. Energii, živiny, alergeny i cenu vždy ověřte na obalu.';

export type DietFlag = FoodItem['diet'][number];

export interface BuiltinFood extends FoodItem {
  source: 'builtin_typical';
  /** Approximate shop price per package in CZK – ESTIMATE. */
  typicalPriceCZK: number;
  priceEstimated: true;
  /** Czech notice: values are typical, check the label. */
  notice: string;
  /** Energy density, kcal per gram (derived). */
  kcalPerG: number;
}

const STAMP = '2025-01-01T00:00:00.000Z';

interface Spec {
  id: string;
  name: string;
  weightG: number;
  /** kcal, protein g, carbs g, fat g per 100 g */
  per100: readonly [number, number, number, number];
  /** water needed per gram of product (ml/g) */
  waterPerG?: number;
  /** needs a stove (boiling water or cooking) */
  heat?: boolean;
  cookMin?: number;
  coldSoak?: boolean;
  allergens?: readonly EuAllergen[];
  diet?: readonly DietFlag[];
  meals: readonly MealType[];
  priceCZK: number;
  shelfDays?: number;
  servings?: number;
}

const VEGAN: readonly DietFlag[] = ['vegan', 'vegetarian', 'lactose_free'];
const VEGAN_GF: readonly DietFlag[] = ['vegan', 'vegetarian', 'gluten_free', 'lactose_free'];
const VEG_GF: readonly DietFlag[] = ['vegetarian', 'gluten_free'];

const r1 = (n: number): number => Math.round(n * 10) / 10;

function make(s: Spec): BuiltinFood {
  const k = s.weightG / 100;
  const energyKcal = Math.round(s.per100[0] * k);
  return {
    id: `builtin:${s.id}`,
    createdAt: STAMP,
    updatedAt: STAMP,
    deletedAt: null,
    name: s.name,
    weightG: s.weightG,
    servings: s.servings ?? 1,
    energyKcal,
    proteinG: r1(s.per100[1] * k),
    carbsG: r1(s.per100[2] * k),
    fatG: r1(s.per100[3] * k),
    price: s.priceCZK,
    currency: 'CZK',
    shelfLifeDays: s.shelfDays,
    waterMl: Math.round((s.waterPerG ?? 0) * s.weightG),
    requiresCooking: s.heat ?? false,
    cookMinutes: s.cookMin ?? 0,
    coldSoakable: s.coldSoak ?? false,
    allergens: [...(s.allergens ?? [])],
    diet: [...(s.diet ?? [])],
    mealTypes: [...s.meals],
    source: 'builtin_typical',
    typicalPriceCZK: s.priceCZK,
    priceEstimated: true,
    notice: BUILTIN_FOOD_NOTICE,
    kcalPerG: r1((energyKcal / s.weightG) * 100) / 100,
  };
}

const SPECS: readonly Spec[] = [
  // --- breakfast bases -------------------------------------------------------
  { id: 'oats-500g', name: 'Ovesné vločky', weightG: 500, per100: [370, 13, 60, 7], waterPerG: 3, heat: true, cookMin: 5, coldSoak: true, allergens: ['gluten'], diet: VEGAN, meals: ['breakfast'], priceCZK: 35, shelfDays: 365 },
  { id: 'instant-porridge-60g', name: 'Instantní ovesná kaše (sáček)', weightG: 60, per100: [380, 9, 68, 8], waterPerG: 2.5, heat: true, cookMin: 0, coldSoak: true, allergens: ['gluten', 'milk'], diet: ['vegetarian'], meals: ['breakfast'], priceCZK: 25, shelfDays: 365 },
  { id: 'muesli-500g', name: 'Müsli', weightG: 500, per100: [380, 10, 62, 9], coldSoak: true, allergens: ['gluten', 'nuts'], diet: VEGAN, meals: ['breakfast', 'snack'], priceCZK: 70, shelfDays: 270 },
  { id: 'granola-400g', name: 'Granola', weightG: 400, per100: [440, 10, 60, 18], coldSoak: true, allergens: ['gluten', 'nuts'], diet: VEGAN, meals: ['breakfast', 'snack'], priceCZK: 100, shelfDays: 270 },
  { id: 'rye-bread-500g', name: 'Žitný chléb balený', weightG: 500, per100: [250, 8, 48, 1.5], allergens: ['gluten'], diet: VEGAN, meals: ['breakfast', 'lunch'], priceCZK: 40, shelfDays: 7 },
  { id: 'crispbread-250g', name: 'Křupavý chléb (knäckebrot)', weightG: 250, per100: [340, 10, 65, 2], allergens: ['gluten'], diet: VEGAN, meals: ['breakfast', 'lunch', 'snack'], priceCZK: 35, shelfDays: 365 },
  { id: 'polenta-500g', name: 'Kukuřičná krupice (polenta)', weightG: 500, per100: [350, 8, 75, 1.5], waterPerG: 4, heat: true, cookMin: 5, diet: VEGAN_GF, meals: ['breakfast', 'dinner'], priceCZK: 35, shelfDays: 365 },
  // --- lunch / dinner bases --------------------------------------------------
  { id: 'tortilla-320g', name: 'Pšeničné tortilly (8 ks)', weightG: 320, per100: [310, 8, 50, 8], allergens: ['gluten'], diet: VEGAN, meals: ['lunch', 'dinner'], priceCZK: 40, shelfDays: 60 },
  { id: 'couscous-500g', name: 'Kuskus', weightG: 500, per100: [360, 12, 72, 1.5], waterPerG: 1.2, heat: true, cookMin: 0, coldSoak: true, allergens: ['gluten'], diet: VEGAN, meals: ['lunch', 'dinner'], priceCZK: 45, shelfDays: 365 },
  { id: 'bulgur-500g', name: 'Bulgur', weightG: 500, per100: [340, 12, 70, 1.5], waterPerG: 2, heat: true, cookMin: 12, coldSoak: true, allergens: ['gluten'], diet: VEGAN, meals: ['lunch', 'dinner'], priceCZK: 50, shelfDays: 365 },
  { id: 'rice-500g', name: 'Rýže dlouhozrnná', weightG: 500, per100: [355, 7, 78, 0.6], waterPerG: 2.2, heat: true, cookMin: 15, diet: VEGAN_GF, meals: ['lunch', 'dinner'], priceCZK: 45, shelfDays: 540 },
  { id: 'pasta-500g', name: 'Těstoviny', weightG: 500, per100: [360, 12, 72, 1.5], waterPerG: 5, heat: true, cookMin: 10, allergens: ['gluten'], diet: VEGAN, meals: ['lunch', 'dinner'], priceCZK: 35, shelfDays: 540 },
  { id: 'rice-noodles-200g', name: 'Rýžové nudle', weightG: 200, per100: [360, 7, 80, 0.5], waterPerG: 6, heat: true, cookMin: 3, coldSoak: true, diet: VEGAN_GF, meals: ['lunch', 'dinner'], priceCZK: 45, shelfDays: 540 },
  { id: 'red-lentils-500g', name: 'Červená čočka', weightG: 500, per100: [350, 25, 50, 1.5], waterPerG: 3, heat: true, cookMin: 15, diet: VEGAN_GF, meals: ['dinner'], priceCZK: 55, shelfDays: 540 },
  { id: 'instant-noodles-85g', name: 'Instantní nudle (sáček)', weightG: 85, per100: [450, 9, 62, 18], waterPerG: 4.7, heat: true, cookMin: 3, coldSoak: false, allergens: ['gluten', 'soy', 'celery'], diet: [], meals: ['lunch', 'dinner'], priceCZK: 20, shelfDays: 365 },
  { id: 'instant-mash-125g', name: 'Instantní bramborová kaše', weightG: 125, per100: [350, 8, 75, 1], waterPerG: 4, heat: true, cookMin: 0, allergens: ['milk'], diet: ['vegetarian', 'gluten_free'], meals: ['dinner'], priceCZK: 40, shelfDays: 365 },
  { id: 'freeze-dried-meal-125g', name: 'Lyofilizované jídlo (typický sáček)', weightG: 125, per100: [410, 17, 55, 14], waterPerG: 2.8, heat: true, cookMin: 0, allergens: ['gluten', 'milk', 'soy', 'celery'], diet: [], meals: ['dinner', 'lunch'], priceCZK: 220, shelfDays: 900 },
  { id: 'instant-soup-60g', name: 'Instantní polévka (sáček)', weightG: 60, per100: [330, 8, 58, 7], waterPerG: 8.3, heat: true, cookMin: 5, allergens: ['gluten', 'celery'], diet: [], meals: ['dinner', 'lunch'], priceCZK: 25, shelfDays: 365 },
  // --- protein / fat ---------------------------------------------------------
  { id: 'hard-cheese-200g', name: 'Tvrdý sýr (eidam/gouda)', weightG: 200, per100: [350, 25, 1, 27], allergens: ['milk'], diet: VEG_GF, meals: ['lunch', 'snack', 'breakfast'], priceCZK: 70, shelfDays: 60 },
  { id: 'dry-salami-100g', name: 'Trvanlivý salám', weightG: 100, per100: [450, 25, 1.5, 38], allergens: ['milk'], diet: ['gluten_free'], meals: ['lunch', 'snack'], priceCZK: 60, shelfDays: 90 },
  { id: 'tuna-pouch-80g', name: 'Tuňák v sáčku', weightG: 80, per100: [130, 25, 0, 3], allergens: ['fish'], diet: ['gluten_free', 'lactose_free'], meals: ['lunch', 'dinner'], priceCZK: 40, shelfDays: 720 },
  { id: 'sardines-120g', name: 'Sardinky v oleji', weightG: 120, per100: [210, 24, 0, 12], allergens: ['fish'], diet: ['gluten_free', 'lactose_free'], meals: ['lunch', 'dinner'], priceCZK: 35, shelfDays: 720 },
  { id: 'jerky-50g', name: 'Sušené maso (jerky)', weightG: 50, per100: [410, 33, 11, 26], allergens: ['soy', 'gluten'], diet: ['lactose_free'], meals: ['snack', 'lunch'], priceCZK: 100, shelfDays: 270 },
  { id: 'peanut-butter-340g', name: 'Arašídové máslo', weightG: 340, per100: [600, 25, 15, 50], allergens: ['peanuts'], diet: [...VEGAN_GF], meals: ['breakfast', 'snack', 'lunch', 'reserve'], priceCZK: 90, shelfDays: 365 },
  { id: 'tahini-250g', name: 'Tahini (sezamová pasta)', weightG: 250, per100: [600, 17, 21, 53], allergens: ['sesame'], diet: VEGAN_GF, meals: ['breakfast', 'lunch'], priceCZK: 100, shelfDays: 365 },
  { id: 'hazelnut-spread-350g', name: 'Oříšková pomazánka s kakaem', weightG: 350, per100: [540, 6, 58, 31], allergens: ['nuts', 'milk', 'soy'], diet: ['vegetarian', 'gluten_free'], meals: ['breakfast', 'snack'], priceCZK: 110, shelfDays: 365 },
  { id: 'olive-oil-250ml', name: 'Olivový olej (250 ml)', weightG: 230, per100: [884, 0, 0, 100], diet: VEGAN_GF, meals: ['lunch', 'dinner'], priceCZK: 130, shelfDays: 540 },
  { id: 'jam-250g', name: 'Marmeláda', weightG: 250, per100: [250, 0.4, 62, 0.1], diet: VEGAN_GF, meals: ['breakfast', 'snack'], priceCZK: 45, shelfDays: 540 },
  // --- snacks ---------------------------------------------------------------
  { id: 'mixed-nuts-200g', name: 'Směs ořechů', weightG: 200, per100: [620, 20, 15, 55], allergens: ['nuts'], diet: VEGAN_GF, meals: ['snack', 'reserve', 'breakfast'], priceCZK: 100, shelfDays: 180 },
  { id: 'almonds-200g', name: 'Mandle', weightG: 200, per100: [580, 21, 22, 50], allergens: ['nuts'], diet: VEGAN_GF, meals: ['snack', 'reserve'], priceCZK: 90, shelfDays: 270 },
  { id: 'trail-mix-200g', name: 'Trail mix (ořechy a ovoce)', weightG: 200, per100: [480, 12, 45, 28], allergens: ['nuts'], diet: VEGAN_GF, meals: ['snack', 'reserve'], priceCZK: 80, shelfDays: 180 },
  { id: 'raisins-200g', name: 'Rozinky', weightG: 200, per100: [300, 3, 72, 0.5], diet: VEGAN_GF, meals: ['snack', 'breakfast'], priceCZK: 40, shelfDays: 365 },
  { id: 'dates-250g', name: 'Datle', weightG: 250, per100: [280, 2, 65, 0.5], diet: VEGAN_GF, meals: ['snack', 'reserve'], priceCZK: 90, shelfDays: 365 },
  { id: 'dried-apricots-200g', name: 'Sušené meruňky', weightG: 200, per100: [240, 3.5, 55, 0.5], allergens: ['sulphites'], diet: VEGAN_GF, meals: ['snack', 'breakfast'], priceCZK: 70, shelfDays: 365 },
  { id: 'dried-apples-100g', name: 'Sušená jablka', weightG: 100, per100: [300, 1, 70, 1], diet: VEGAN_GF, meals: ['snack'], priceCZK: 40, shelfDays: 365 },
  { id: 'dark-chocolate-100g', name: 'Hořká čokoláda (70 %)', weightG: 100, per100: [540, 7, 45, 35], allergens: ['soy'], diet: VEGAN_GF, meals: ['snack', 'reserve'], priceCZK: 35, shelfDays: 365 },
  { id: 'energy-bar-50g', name: 'Energetická tyčinka', weightG: 50, per100: [400, 8, 55, 16], allergens: ['nuts', 'soy', 'gluten'], diet: ['vegetarian'], meals: ['snack', 'reserve'], priceCZK: 35, shelfDays: 270 },
  { id: 'flapjack-60g', name: 'Ovesný flapjack', weightG: 60, per100: [450, 6, 60, 20], allergens: ['gluten', 'milk'], diet: ['vegetarian'], meals: ['snack', 'breakfast'], priceCZK: 25, shelfDays: 120 },
  { id: 'energy-gel-40g', name: 'Energetický gel', weightG: 40, per100: [250, 0, 62, 0], diet: VEGAN_GF, meals: ['snack'], priceCZK: 45, shelfDays: 540 },
  { id: 'rice-cakes-100g', name: 'Rýžové chlebíčky', weightG: 100, per100: [380, 8, 80, 3], diet: VEGAN_GF, meals: ['snack', 'breakfast'], priceCZK: 25, shelfDays: 270 },
  { id: 'biscuits-150g', name: 'Sušenky / oplatky', weightG: 150, per100: [480, 6, 66, 22], allergens: ['gluten', 'milk', 'soy'], diet: ['vegetarian'], meals: ['snack'], priceCZK: 25, shelfDays: 180 },
  { id: 'chips-100g', name: 'Bramborové lupínky', weightG: 100, per100: [540, 6, 50, 35], diet: VEGAN_GF, meals: ['snack'], priceCZK: 35, shelfDays: 120 },
  { id: 'honey-250g', name: 'Med', weightG: 250, per100: [330, 0.4, 82, 0], diet: ['vegetarian', 'gluten_free', 'lactose_free'], meals: ['breakfast', 'snack'], priceCZK: 80, shelfDays: 1000 },
  { id: 'condensed-milk-170g', name: 'Kondenzované mléko (tuba)', weightG: 170, per100: [330, 8, 55, 9], allergens: ['milk'], diet: VEG_GF, meals: ['breakfast', 'snack'], priceCZK: 40, shelfDays: 365 },
  // --- drinks and add-ons ------------------------------------------------------
  { id: 'powdered-milk-400g', name: 'Sušené mléko plnotučné', weightG: 400, per100: [500, 26, 38, 27], waterPerG: 7, coldSoak: true, allergens: ['milk'], diet: VEG_GF, meals: ['breakfast', 'drink'], priceCZK: 90, shelfDays: 365 },
  { id: 'instant-coffee-100g', name: 'Instantní káva', weightG: 100, per100: [240, 12, 41, 0.5], waterPerG: 125, heat: true, cookMin: 0, diet: VEGAN_GF, meals: ['drink'], priceCZK: 120, shelfDays: 720 },
  { id: 'tea-40g', name: 'Čaj (20 sáčků)', weightG: 40, per100: [2, 0, 0, 0], waterPerG: 125, heat: true, cookMin: 0, diet: VEGAN_GF, meals: ['drink'], priceCZK: 40, shelfDays: 720 },
  { id: 'hot-chocolate-200g', name: 'Instantní horká čokoláda', weightG: 200, per100: [390, 6, 80, 5], waterPerG: 10, heat: true, cookMin: 0, allergens: ['milk', 'soy'], diet: ['vegetarian'], meals: ['drink', 'snack'], priceCZK: 70, shelfDays: 365 },
  { id: 'isotonic-powder-500g', name: 'Isotonický prášek', weightG: 500, per100: [380, 0, 94, 0], waterPerG: 16.7, coldSoak: true, diet: VEGAN_GF, meals: ['drink'], priceCZK: 160, shelfDays: 540 },
  { id: 'sugar-250g', name: 'Cukr krystal', weightG: 250, per100: [400, 0, 100, 0], diet: VEGAN_GF, meals: ['drink', 'breakfast'], priceCZK: 15, shelfDays: 1000 },
  { id: 'protein-powder-500g', name: 'Proteinový prášek (mléčný)', weightG: 500, per100: [380, 75, 8, 6], waterPerG: 6, coldSoak: true, allergens: ['milk', 'soy'], diet: ['vegetarian'], meals: ['drink', 'breakfast'], priceCZK: 350, shelfDays: 540 },
];

/** Built-in trail foods (stable ids `builtin:<slug>`), all `source: 'builtin_typical'`. */
export const BUILTIN_FOODS: readonly BuiltinFood[] = SPECS.map(make);

const BY_ID = new Map(BUILTIN_FOODS.map((f) => [f.id, f]));

export const getBuiltinFood = (id: string): BuiltinFood | undefined => BY_ID.get(id);

const ALLERGEN_ALIASES: Record<string, EuAllergen> = {
  lepek: 'gluten',
  gluten: 'gluten',
  pseniceny: 'gluten',
  korysi: 'crustaceans',
  crustaceans: 'crustaceans',
  vejce: 'eggs',
  eggs: 'eggs',
  egg: 'eggs',
  ryby: 'fish',
  ryba: 'fish',
  fish: 'fish',
  arasidy: 'peanuts',
  peanuts: 'peanuts',
  peanut: 'peanuts',
  soja: 'soy',
  soy: 'soy',
  mleko: 'milk',
  milk: 'milk',
  laktoza: 'milk',
  orechy: 'nuts',
  skorapkove: 'nuts',
  nuts: 'nuts',
  celer: 'celery',
  celery: 'celery',
  horcice: 'mustard',
  mustard: 'mustard',
  sezam: 'sesame',
  sesame: 'sesame',
  siricitany: 'sulphites',
  sulphites: 'sulphites',
  sulfites: 'sulphites',
  lupina: 'lupin',
  lupin: 'lupin',
  merkove: 'molluscs',
  molluscs: 'molluscs',
};

/** Map a Czech or English allergen name to the canonical EU key (unknown names are lower-cased). */
export function normalizeAllergen(name: string): string {
  const k = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
  return ALLERGEN_ALIASES[k] ?? k;
}

/** Czech labels for the EU allergens. */
export const ALLERGEN_LABELS_CS: Record<EuAllergen, string> = {
  gluten: 'lepek',
  crustaceans: 'korýši',
  eggs: 'vejce',
  fish: 'ryby',
  peanuts: 'arašídy',
  soy: 'sója',
  milk: 'mléko',
  nuts: 'skořápkové plody',
  celery: 'celer',
  mustard: 'hořčice',
  sesame: 'sezam',
  sulphites: 'siřičitany',
  lupin: 'lupina',
  molluscs: 'měkkýši',
};
