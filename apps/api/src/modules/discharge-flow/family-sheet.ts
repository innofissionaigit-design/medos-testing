// The sheet handed to the family at the bedside (docs/discharge-flow.md): what is still pending before the patient can go home, and who is handling it.
// Plain words only: no clinical detail, no money amounts. English, Hindi and Bengali; the hospital's own name and footer come from the print settings.

export const FAMILY_LANGS = ["en", "hi", "bn"] as const;
export type FamilyLang = (typeof FAMILY_LANGS)[number];



type Words = {
  title: string; patient: string; expected: string; waitingSince: string; pendingHeading: string; allDone: string; handledBy: string; reason: string; footer: string;
  stage: Record<string, string>; owner: Record<string, string>;
};

const WORDS: Record<FamilyLang, Words> = {
  en: {
    title: "Going home: what is pending", patient: "Patient", expected: "Expected going-home date", waitingSince: "Doctor said fit to go at", pendingHeading: "Still to be done", allDone: "Everything is ready. Please wait for the ward nurse to take you out.", handledBy: "Handled by", reason: "Why it is waiting", footer: "Please ask the ward nurse if you have any question.",
    stage: { NURSING: "Nursing and medicine records", CHARGES_REVIEWED: "Checking all charges", PHARMACY: "Medicines from the pharmacy", LAB_RADIOLOGY: "Tests and reports", OT_PROCEDURE: "Procedure records", INSURANCE: "Insurance papers and approval", BILLING: "Final bill and payment", FINANCIAL_RELEASE: "Payment clearance", SUMMARY: "Doctor's discharge summary", EXIT: "Leaving the ward", INSURER_PAYMENT: "Insurance company's reply" },
    owner: { NURSE: "Ward nurse", BILLING: "Billing desk", PHARMACY: "Pharmacy", DOCTOR: "Doctor", LAB: "Laboratory / scan department", OT: "Procedure team", INSURANCE: "Insurance desk", FINANCE: "Billing / finance", TRANSPORT: "Ward nurse / patient transport" },
  },
  hi: {
    title: "घर जाने से पहले क्या बाकी है", patient: "मरीज़", expected: "घर जाने की संभावित तारीख", waitingSince: "डॉक्टर ने घर जाने की अनुमति दी", pendingHeading: "अभी बाकी काम", allDone: "सब कुछ तैयार है। कृपया वार्ड नर्स के आने की प्रतीक्षा करें।", handledBy: "ज़िम्मेदार", reason: "देरी का कारण", footer: "कोई सवाल हो तो वार्ड नर्स से पूछें।",
    stage: { NURSING: "नर्सिंग और दवा का रिकॉर्ड", CHARGES_REVIEWED: "सभी शुल्कों की जाँच", PHARMACY: "फार्मेसी से दवाइयाँ", LAB_RADIOLOGY: "जाँच और रिपोर्ट", OT_PROCEDURE: "प्रक्रिया का रिकॉर्ड", INSURANCE: "बीमा के कागज़ और मंज़ूरी", BILLING: "अंतिम बिल और भुगतान", FINANCIAL_RELEASE: "भुगतान की मंज़ूरी", SUMMARY: "डॉक्टर का डिस्चार्ज सारांश", EXIT: "वार्ड से रवानगी", INSURER_PAYMENT: "बीमा कंपनी का जवाब" },
    owner: { NURSE: "वार्ड नर्स", BILLING: "बिलिंग डेस्क", PHARMACY: "फार्मेसी", DOCTOR: "डॉक्टर", LAB: "प्रयोगशाला / स्कैन विभाग", OT: "प्रक्रिया टीम", INSURANCE: "बीमा डेस्क", FINANCE: "बिलिंग / वित्त", TRANSPORT: "वार्ड नर्स / मरीज़ परिवहन" },
  },
  bn: {
    title: "বাড়ি যাওয়ার আগে কী বাকি আছে", patient: "রোগী", expected: "বাড়ি যাওয়ার সম্ভাব্য তারিখ", waitingSince: "ডাক্তার বাড়ি যাওয়ার অনুমতি দিয়েছেন", pendingHeading: "এখনও বাকি কাজ", allDone: "সব প্রস্তুত। অনুগ্রহ করে ওয়ার্ডের নার্সের জন্য অপেক্ষা করুন।", handledBy: "দায়িত্বে", reason: "দেরির কারণ", footer: "কোনও প্রশ্ন থাকলে ওয়ার্ডের নার্সকে জিজ্ঞাসা করুন।",
    stage: { NURSING: "নার্সিং ও ওষুধের রেকর্ড", CHARGES_REVIEWED: "সব খরচ যাচাই", PHARMACY: "ফার্মেসি থেকে ওষুধ", LAB_RADIOLOGY: "পরীক্ষা ও রিপোর্ট", OT_PROCEDURE: "প্রক্রিয়ার রেকর্ড", INSURANCE: "বিমার কাগজপত্র ও অনুমোদন", BILLING: "চূড়ান্ত বিল ও পেমেন্ট", FINANCIAL_RELEASE: "পেমেন্টের ছাড়পত্র", SUMMARY: "ডাক্তারের ডিসচার্জ সারাংশ", EXIT: "ওয়ার্ড থেকে বেরোনো", INSURER_PAYMENT: "বিমা কোম্পানির উত্তর" },
    owner: { NURSE: "ওয়ার্ড নার্স", BILLING: "বিলিং ডেস্ক", PHARMACY: "ফার্মেসি", DOCTOR: "ডাক্তার", LAB: "পরীক্ষাগার / স্ক্যান বিভাগ", OT: "প্রক্রিয়া দল", INSURANCE: "বিমা ডেস্ক", FINANCE: "বিলিং / অর্থ", TRANSPORT: "ওয়ার্ড নার্স / রোগী পরিবহন" },
  },
};

/** Who answers for each stage, as a key the sheet can translate. */
export const OWNER_KEY: Record<string, string> = {
  NURSING: "NURSE", CHARGES_REVIEWED: "BILLING", PHARMACY: "PHARMACY", LAB_RADIOLOGY: "LAB", OT_PROCEDURE: "OT", INSURANCE: "INSURANCE", BILLING: "BILLING",
  FINANCIAL_RELEASE: "FINANCE", SUMMARY: "DOCTOR", EXIT: "TRANSPORT", INSURER_PAYMENT: "INSURANCE",
};

export interface FamilySheetInput {
  lang: FamilyLang; patientName: string; expectedDate: string | null; fitAt: string | null;
  pending: { stage: string }[]; /** The newest reason code for each stage, if somebody recorded one. */ reasonCodes?: Record<string, string>;
}

export interface FamilySheet { lang: FamilyLang; title: string; lines: string[]; pending: { stage: string; what: string; handledBy: string; reason: string | null }[]; allDone: boolean }

/** Words for a delay reason in each language (the same fixed list as DELAY_REASONS). */
export const REASON_WORDS: Record<string, Record<FamilyLang, string>> = {
  WAITING_FOR_INSURANCE: { en: "Waiting for the insurance company", hi: "बीमा कंपनी के जवाब की प्रतीक्षा", bn: "বিমা কোম্পানির উত্তরের অপেক্ষা" },
  FAMILY_ARRANGING_MONEY: { en: "Family arranging payment", hi: "परिवार भुगतान का इंतज़ाम कर रहा है", bn: "পরিবার টাকার ব্যবস্থা করছে" },
  SUMMARY_NOT_WRITTEN: { en: "Discharge summary not yet written", hi: "डिस्चार्ज सारांश अभी नहीं लिखा गया", bn: "ডিসচার্জ সারাংশ এখনও লেখা হয়নি" },
  WAITING_FOR_LAB_OR_REPORT: { en: "Waiting for a test or report", hi: "जाँच या रिपोर्ट की प्रतीक्षा", bn: "পরীক্ষা বা রিপোর্টের অপেক্ষা" },
  WAITING_FOR_MEDICINES: { en: "Waiting for medicines", hi: "दवाइयों की प्रतीक्षा", bn: "ওষুধের অপেক্ষা" },
  WAITING_FOR_DOCTOR: { en: "Waiting for the doctor", hi: "डॉक्टर की प्रतीक्षा", bn: "ডাক্তারের অপেক্ষা" },
  WAITING_FOR_TRANSPORT: { en: "Waiting for transport", hi: "परिवहन की प्रतीक्षा", bn: "পরিবহনের অপেক্ষা" },
  PATIENT_OR_FAMILY_NOT_READY: { en: "Patient or family not ready yet", hi: "मरीज़ या परिवार अभी तैयार नहीं", bn: "রোগী বা পরিবার এখনও প্রস্তুত নয়" },
  OTHER: { en: "Other reason (ask the ward nurse)", hi: "अन्य कारण (वार्ड नर्स से पूछें)", bn: "অন্য কারণ (ওয়ার্ড নার্সকে জিজ্ঞাসা করুন)" },
};

/** The family's sheet. It never carries amounts, diagnoses or the free-text note someone typed for the staff. */
export function buildFamilySheet(i: FamilySheetInput): FamilySheet {
  const w = WORDS[i.lang];
  const pending = i.pending.map((p) => ({
    stage: p.stage,
    what: w.stage[p.stage] ?? p.stage,
    handledBy: w.owner[OWNER_KEY[p.stage] ?? ""] ?? "",
    reason: i.reasonCodes?.[p.stage] ? REASON_WORDS[i.reasonCodes[p.stage]!]?.[i.lang] ?? null : null,
  }));
  const lines = [w.title, `${w.patient}: ${i.patientName}`];
  if (i.expectedDate) lines.push(`${w.expected}: ${i.expectedDate}`);
  if (i.fitAt) lines.push(`${w.waitingSince}: ${i.fitAt}`);
  if (pending.length === 0) lines.push(w.allDone);
  else {
    lines.push(`${w.pendingHeading}:`);
    pending.forEach((p, n) => lines.push(`${n + 1}. ${p.what} (${w.handledBy}: ${p.handledBy})${p.reason ? ` · ${w.reason}: ${p.reason}` : ""}`));
  }
  lines.push(w.footer);
  return { lang: i.lang, title: w.title, lines, pending, allDone: pending.length === 0 };
}
