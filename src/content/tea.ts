// Every word on the site. Edit copy here; scene code never needs to change.

export const teaBrand = {
  name: "Kinari",
  mark: "KINARI",
  suffix: "Tea House",
  description:
    "Single-estate loose leaf tea, rolled by hand and brewed in glass. Scroll to watch one pot come to life.",
  // Placeholder: replace with the real WhatsApp number (country code, no plus sign).
  whatsapp: "923000000000",
  whatsappMessage: "Hi Kinari, I would like to order a tin of Golden Hour.",
};

export const teaNav = ["Collections", "The Leaf", "Our Story", "Visit"];

export type TeaSection = {
  id: string;
  eyebrow: string;
  title: [string, string];
  body: string;
  align: "center" | "left" | "right";
};

export const teaSections: TeaSection[] = [
  {
    id: "hero",
    eyebrow: "01  The ritual",
    title: ["Brewed", "in gold."],
    body: "A single leaf. A glass pot. Hot water and a little patience. Scroll to brew a pot with us.",
    align: "center",
  },
  {
    id: "unwrap",
    eyebrow: "02  The harvest",
    title: ["Nature,", "unwrapped."],
    body: "Picked at first light on high estates, then sealed in foil the same week so nothing fades.",
    align: "right",
  },
  {
    id: "glass",
    eyebrow: "03  The leaf",
    title: ["Into the", "glass."],
    body: "Whole leaves, dried marigold and a curl of mint. Nothing crushed, nothing hidden.",
    align: "left",
  },
  {
    id: "stir",
    eyebrow: "04  The steep",
    title: ["The water", "stirs."],
    body: "At 85 degrees the leaves wake up, unfold and start to dance.",
    align: "right",
  },
  {
    id: "gold",
    eyebrow: "05  The colour",
    title: ["A colour", "of gold."],
    body: "Four minutes turns clear water to amber. Honey on the nose, a soft malt finish.",
    align: "left",
  },
  {
    id: "pour",
    eyebrow: "06  The pour",
    title: ["Poured,", "slowly."],
    body: "Warm the cup first. Pour from a little height so the tea can breathe.",
    align: "right",
  },
  {
    id: "calm",
    eyebrow: "07  The moment",
    title: ["Your moment", "of calm."],
    body: "Golden Hour loose leaf, 100g tin. Brews about forty cups.",
    align: "left",
  },
];

export const teaCta = {
  primary: "Shop the blends",
  secondary: "Scroll to brew",
  order: "Order on WhatsApp",
  explore: "See all blends",
};
