// Pronunciation fixes for narration (Oct 10 2026).
//
// Viewers complained about mispronounced names ("Sipendi venye unatamka
// Onyango 😂"). The text sent to the voice is rewritten with these spellings;
// captions keep the original words.
//
// Two lists:
//  - ACRONYMS: always spelled out letter by letter, for every voice.
//  - NAMES: phonetic respellings. The Kenyan voices (en-KE-*) already say
//    most Kenyan names correctly, so NAMES are applied only to non-Kenyan
//    voices unless `allVoices` is set. Add a name here whenever viewers say
//    it was mispronounced.

const ACRONYMS = {
  KOT: "K O T",
  MCA: "M C A",
  MCAs: "M C As",
  MP: "M P",
  MPs: "M Ps",
  IEBC: "I E B C",
  ODM: "O D M",
  UDA: "U D A",
  JKIA: "J K I A",
  KNH: "K N H",
  DCI: "D C I",
  CS: "C S",
  PS: "P S",
  CBK: "C B K",
  KRA: "K R A",
};

const NAMES = {
  Onyango: "Oh-nyah-ngo",
  Odinga: "Oh-ding-ga",
  Raila: "Rye-la",
  Oburu: "Oh-boo-roo",
  Sifuna: "See-foo-na",
  Mudavadi: "Moo-da-vah-dee",
  Kalonzo: "Ka-lon-zo",
  Musyoka: "Moo-syo-ka",
  "Wetang'ula": "Weh-tan-goo-la",
  Wetangula: "Weh-tan-goo-la",
  Gachagua: "Ga-cha-gwa",
  Kindiki: "Kin-dee-kee",
  Kenyatta: "Ken-yah-ta",
  Ruto: "Roo-toh",
  Babu: "Bah-boo",
  Owino: "Oh-wee-no",
  Nyoro: "Nyo-ro",
  Ndindi: "N-din-dee",
  Rongai: "Ron-guy",
  Kisumu: "Kee-soo-moo",
  Nyeri: "Nyeh-ree",
  Mombasa: "Mom-bah-sa",
  Eldoret: "El-doh-ret",
  Nakuru: "Na-koo-roo",
  Kikuyu: "Kee-koo-yoo",
  Luo: "Loo-oh",
  Mzansi: "M-zahn-see",
  Naija: "Nai-jah",
  Sheng: "Sheng",
  Wanjiku: "Wahn-jee-koo",
  Kamau: "Ka-mow",
  Otieno: "Oh-tee-eh-no",
  Achieng: "Ah-chee-eng",
  Wangari: "Wahn-gah-ree",
  Maathai: "Mah-tie",
};

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Rewrites narration text so the voice pronounces names and acronyms
 * properly. Captions should keep using the original text.
 * @param {string} text
 * @param {{voice?: string, allVoices?: boolean}} [opts]
 */
export function forSpeech(text, opts = {}) {
  let out = String(text);
  for (const [k, v] of Object.entries(ACRONYMS)) {
    out = out.replace(new RegExp(`(?<![\\w#@])${escapeRe(k)}(?![\\w])`, "g"), v);
  }
  const kenyanVoice = /^en-KE-/i.test(opts.voice || "");
  if (opts.allVoices || !kenyanVoice) {
    for (const [k, v] of Object.entries(NAMES)) {
      out = out.replace(new RegExp(`(?<![\\w#@])${escapeRe(k)}(?![\\w])`, "g"), v);
    }
  }
  return out;
}

export const PRONUNCIATIONS = { ACRONYMS, NAMES };
