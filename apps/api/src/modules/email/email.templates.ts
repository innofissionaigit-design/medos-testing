/**
 * The emails the system can send (docs/email.md). Each has built-in wording in English, Bengali and Hindi, a fixed list of placeholders, and can be reworded by a
 * hospital (EmailTemplate). Placeholders are written {like_this}; only the listed ones are allowed, so a template can never reach into data it was not given.
 * No template carries clinical content: a report-ready email says a report is ready, never what it says.
 */
export const LANGUAGES = ["en", "bn", "hi"] as const;
export type EmailLanguage = (typeof LANGUAGES)[number];

export const TEMPLATE_KEYS = ["APPOINTMENT_BOOKED", "APPOINTMENT_CANCELLED", "RECEIPT", "REPORT_READY", "TEST"] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

export interface TemplateDef {
  key: TemplateKey;
  label: string;
  description: string;
  /** The placeholders this template may use, and an example of each for the preview. */
  vars: Record<string, string>;
  defaults: Record<EmailLanguage, { subject: string; body: string }>;
}

export const TEMPLATES: Record<TemplateKey, TemplateDef> = {
  APPOINTMENT_BOOKED: {
    key: "APPOINTMENT_BOOKED", label: "Appointment booked", description: "Sent to the patient when an appointment is booked.",
    vars: { name: "Asha", doctor: "Dr. Rao", when: "12 Nov 2026, 10:30 am", facility: "City Hospital" },
    defaults: {
      en: { subject: "Your appointment at {facility}", body: "Dear {name},\n\nYour appointment with {doctor} at {facility} is booked for {when}.\n\nIf you cannot come, please tell the hospital so the time can be given to someone else.\n\n{facility}" },
      bn: { subject: "{facility}-এ আপনার অ্যাপয়েন্টমেন্ট", body: "প্রিয় {name},\n\n{facility}-এ {doctor}-এর সাথে আপনার অ্যাপয়েন্টমেন্ট {when}-এ নির্ধারিত হয়েছে।\n\nআসতে না পারলে অনুগ্রহ করে হাসপাতালকে জানান, যাতে সময়টি অন্য কাউকে দেওয়া যায়।\n\n{facility}" },
      hi: { subject: "{facility} में आपका अपॉइंटमेंट", body: "प्रिय {name},\n\n{facility} में {doctor} के साथ आपका अपॉइंटमेंट {when} के लिए बुक हो गया है।\n\nयदि आप नहीं आ सकते, तो कृपया अस्पताल को बताएँ ताकि यह समय किसी और को दिया जा सके।\n\n{facility}" },
    },
  },
  APPOINTMENT_CANCELLED: {
    key: "APPOINTMENT_CANCELLED", label: "Appointment cancelled", description: "Sent to the patient when an appointment is cancelled (by staff, by the patient, or automatically).",
    vars: { name: "Asha", doctor: "Dr. Rao", when: "12 Nov 2026, 10:30 am", facility: "City Hospital" },
    defaults: {
      en: { subject: "Your appointment has been cancelled", body: "Dear {name},\n\nYour appointment with {doctor} at {facility} on {when} has been cancelled. Please contact the hospital to book another time.\n\n{facility}" },
      bn: { subject: "আপনার অ্যাপয়েন্টমেন্ট বাতিল হয়েছে", body: "প্রিয় {name},\n\n{facility}-এ {doctor}-এর সাথে {when}-এর আপনার অ্যাপয়েন্টমেন্ট বাতিল করা হয়েছে। অন্য সময় বুক করতে অনুগ্রহ করে হাসপাতালের সাথে যোগাযোগ করুন।\n\n{facility}" },
      hi: { subject: "आपका अपॉइंटमेंट रद्द हो गया है", body: "प्रिय {name},\n\n{facility} में {doctor} के साथ {when} का आपका अपॉइंटमेंट रद्द कर दिया गया है। दूसरा समय बुक करने के लिए कृपया अस्पताल से संपर्क करें।\n\n{facility}" },
    },
  },
  RECEIPT: {
    key: "RECEIPT", label: "Payment receipt", description: "Sent when staff press Email receipt on a bill: the bill number and the amount, not the itemised bill.",
    vars: { name: "Asha", invoiceNumber: "INV-2026-000123", amount: "₹500.00", facility: "City Hospital" },
    defaults: {
      en: { subject: "Your payment receipt — {facility}", body: "Dear {name},\n\nThank you. We received your payment of {amount} for bill {invoiceNumber} at {facility}. Please keep this email as a record. The printed receipt is available at the counter.\n\n{facility}" },
      bn: { subject: "আপনার পেমেন্টের রসিদ — {facility}", body: "প্রিয় {name},\n\nধন্যবাদ। {facility}-এ বিল {invoiceNumber}-এর জন্য আপনার {amount} পেমেন্ট আমরা পেয়েছি। রেকর্ড হিসেবে এই ইমেইলটি রাখুন। ছাপানো রসিদ কাউন্টারে পাওয়া যাবে।\n\n{facility}" },
      hi: { subject: "आपके भुगतान की रसीद — {facility}", body: "प्रिय {name},\n\nधन्यवाद। {facility} में बिल {invoiceNumber} के लिए आपका {amount} का भुगतान हमें मिल गया है। कृपया इस ईमेल को रिकॉर्ड के रूप में रखें। छपी हुई रसीद काउंटर पर उपलब्ध है।\n\n{facility}" },
    },
  },
  REPORT_READY: {
    key: "REPORT_READY", label: "Report ready", description: "Sent when a laboratory or radiology report is released. It says only that a report is ready, never what it says.",
    vars: { name: "Asha", facility: "City Hospital" },
    defaults: {
      en: { subject: "Your report is ready — {facility}", body: "Dear {name},\n\nA report for you is ready at {facility}. Please collect it from the hospital or sign in to the patient app to see it. For your privacy, test results are not sent by email.\n\n{facility}" },
      bn: { subject: "আপনার রিপোর্ট প্রস্তুত — {facility}", body: "প্রিয় {name},\n\n{facility}-এ আপনার একটি রিপোর্ট প্রস্তুত। অনুগ্রহ করে হাসপাতাল থেকে সংগ্রহ করুন বা রোগীর অ্যাপে সাইন ইন করে দেখুন। আপনার গোপনীয়তার জন্য পরীক্ষার ফলাফল ইমেইলে পাঠানো হয় না।\n\n{facility}" },
      hi: { subject: "आपकी रिपोर्ट तैयार है — {facility}", body: "प्रिय {name},\n\n{facility} में आपकी एक रिपोर्ट तैयार है। कृपया अस्पताल से ले लें या रोगी ऐप में साइन इन करके देखें। आपकी गोपनीयता के लिए जाँच के परिणाम ईमेल से नहीं भेजे जाते।\n\n{facility}" },
    },
  },
  TEST: {
    key: "TEST", label: "Test email", description: "Sent by an administrator to check that email works.",
    vars: { facility: "City Hospital" },
    defaults: {
      en: { subject: "Test email from {facility}", body: "This is a test email from {facility}. If you can read this, email is working." },
      bn: { subject: "{facility} থেকে পরীক্ষামূলক ইমেইল", body: "এটি {facility} থেকে একটি পরীক্ষামূলক ইমেইল। আপনি এটি পড়তে পারলে ইমেইল কাজ করছে।" },
      hi: { subject: "{facility} की ओर से परीक्षण ईमेल", body: "यह {facility} की ओर से एक परीक्षण ईमेल है। यदि आप इसे पढ़ पा रहे हैं, तो ईमेल काम कर रहा है।" },
    },
  },
};

export const isTemplateKey = (k: string): k is TemplateKey => (TEMPLATE_KEYS as readonly string[]).includes(k);

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** The placeholders a piece of text uses. */
export function placeholdersIn(text: string): string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1] as string))];
}

/** Why a hospital's wording cannot be saved, or null. Unknown placeholders and stray braces are refused; the subject must be one line. */
export function templateProblem(key: TemplateKey, subject: string, body: string): string | null {
  const allowed = Object.keys(TEMPLATES[key].vars);
  if (/[\r\n]/.test(subject)) return "The subject must be one line";
  for (const text of [subject, body]) {
    const bad = placeholdersIn(text).filter((p) => !allowed.includes(p));
    if (bad.length > 0) return `Unknown placeholder {${bad[0]}}. This email may use: ${allowed.map((a) => `{${a}}`).join(", ")}`;
    if (/\{|\}/.test(text.replace(PLACEHOLDER, ""))) return "A curly bracket is left over: write placeholders exactly like {name}";
  }
  if (subject.trim().length < 1 || subject.length > 200) return "The subject must be 1 to 200 characters";
  if (body.trim().length < 1 || body.length > 4000) return "The text must be 1 to 4000 characters";
  return null;
}

/** A value from the system, made safe to put in a line: no line breaks, no control characters, bounded. */
const clean = (v: string): string => v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);

export function fill(text: string, vars: Record<string, string>): string {
  return text.replace(PLACEHOLDER, (_m, name: string) => clean(vars[name] ?? ""));
}

const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** The plain text as simple HTML: paragraphs and line breaks, everything escaped. */
export function toHtml(text: string): string {
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1e293b">${text.split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`).join("")}</div>`;
}

export interface Rendered { subject: string; text: string; html: string }

/** The wording used (the hospital's own, else the built-in) with the values filled in. */
export function render(key: TemplateKey, language: EmailLanguage, vars: Record<string, string>, override?: { subject: string; body: string } | null): Rendered {
  const base = override ?? TEMPLATES[key].defaults[language];
  const subject = fill(base.subject, vars).slice(0, 200) || TEMPLATES[key].defaults[language].subject;
  const text = fill(base.body, vars);
  return { subject, text, html: toHtml(text) };
}

const LOCALE: Record<EmailLanguage, string> = { en: "en-IN-u-nu-latn", bn: "bn-IN-u-nu-latn", hi: "hi-IN-u-nu-latn" };

/** "12 Nov 2026, 10:30 am" in the facility's time zone and the email's language. */
export function formatWhen(at: Date, timeZone: string, language: EmailLanguage): string {
  return new Intl.DateTimeFormat(LOCALE[language], { timeZone, dateStyle: "medium", timeStyle: "short" }).format(at);
}
