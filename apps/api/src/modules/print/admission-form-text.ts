/**
 * The words on the printed admission form, in English, Bengali and Hindi (docs/admission-form.md). The consent paragraph is a starting text only: each hospital
 * replaces it with wording approved by its own legal adviser (settings ADMISSION_CONSENT_TEXT, _BN and _HI), and the Bengali and Hindi texts here have not yet been
 * reviewed by a native speaker (docs/backlog.md).
 */
export type FormLang = "en" | "bn" | "hi";

export interface FormText {
  title: string; admission: string; patient: string; contacts: string; consent: string;
  admissionNo: string; admitted: string; consultant: string; department: string; wardBed: string; reason: string;
  name: string; mrn: string; gender: string; ageDob: string; bloodGroup: string; mobile: string; address: string;
  guardian: string; emergency: string; allergies: string;
  patientSignature: string; nameRelationship: string; dateTime: string; admittingDoctor: string;
}

export const FORM_TEXT: Record<FormLang, FormText> = {
  en: {
    title: "Admission Form", admission: "Admission", patient: "Patient", contacts: "Contacts", consent: "Consent and declaration",
    admissionNo: "Admission no.", admitted: "Admitted", consultant: "Consultant", department: "Department", wardBed: "Ward and bed", reason: "Reason for admission",
    name: "Name", mrn: "MRN", gender: "Gender", ageDob: "Age/DOB", bloodGroup: "Blood group", mobile: "Mobile", address: "Address",
    guardian: "Guardian", emergency: "Emergency contact", allergies: "Known allergies",
    patientSignature: "Patient or relative: signature", nameRelationship: "Name and relationship", dateTime: "Date and time", admittingDoctor: "Admitting doctor",
  },
  bn: {
    title: "ভর্তি ফর্ম", admission: "ভর্তি", patient: "রোগী", contacts: "যোগাযোগ", consent: "সম্মতি ও ঘোষণা",
    admissionNo: "ভর্তি নম্বর", admitted: "ভর্তির সময়", consultant: "চিকিৎসক (কনসালট্যান্ট)", department: "বিভাগ", wardBed: "ওয়ার্ড ও বেড", reason: "ভর্তির কারণ",
    name: "নাম", mrn: "এমআরএন", gender: "লিঙ্গ", ageDob: "বয়স/জন্মতারিখ", bloodGroup: "রক্তের গ্রুপ", mobile: "মোবাইল", address: "ঠিকানা",
    guardian: "অভিভাবক", emergency: "জরুরি যোগাযোগ", allergies: "জানা অ্যালার্জি",
    patientSignature: "রোগী বা আত্মীয়ের স্বাক্ষর", nameRelationship: "নাম ও সম্পর্ক", dateTime: "তারিখ ও সময়", admittingDoctor: "ভর্তিকারী চিকিৎসক",
  },
  hi: {
    title: "भर्ती फ़ॉर्म", admission: "भर्ती", patient: "मरीज़", contacts: "संपर्क", consent: "सहमति और घोषणा",
    admissionNo: "भर्ती संख्या", admitted: "भर्ती का समय", consultant: "परामर्शदाता चिकित्सक", department: "विभाग", wardBed: "वार्ड और बिस्तर", reason: "भर्ती का कारण",
    name: "नाम", mrn: "एमआरएन", gender: "लिंग", ageDob: "आयु/जन्मतिथि", bloodGroup: "रक्त समूह", mobile: "मोबाइल", address: "पता",
    guardian: "अभिभावक", emergency: "आपातकालीन संपर्क", allergies: "ज्ञात एलर्जी",
    patientSignature: "मरीज़ या रिश्तेदार के हस्ताक्षर", nameRelationship: "नाम और संबंध", dateTime: "तारीख़ और समय", admittingDoctor: "भर्ती करने वाले चिकित्सक",
  },
};

export const DEFAULT_CONSENT: Record<FormLang, string> = {
  en: "I agree to be admitted to this hospital and to the examinations and treatment my doctors advise. The nature of my condition, the planned treatment and the charges have been explained to me, and I have had the chance to ask questions. I understand that I may ask for a copy of my medical records and that the hospital will keep my information confidential.",
  bn: "আমি এই হাসপাতালে ভর্তি হতে এবং আমার চিকিৎসকদের পরামর্শ অনুযায়ী পরীক্ষা ও চিকিৎসা করাতে সম্মত। আমার রোগের প্রকৃতি, প্রস্তাবিত চিকিৎসা এবং খরচ আমাকে বুঝিয়ে বলা হয়েছে এবং প্রশ্ন করার সুযোগ পেয়েছি। আমি বুঝি যে আমি আমার চিকিৎসা-নথির একটি কপি চাইতে পারি এবং হাসপাতাল আমার তথ্য গোপন রাখবে।",
  hi: "मैं इस अस्पताल में भर्ती होने और अपने चिकित्सकों द्वारा सुझाई गई जाँच और उपचार के लिए सहमत हूँ। मुझे मेरी बीमारी की प्रकृति, प्रस्तावित उपचार और शुल्क समझाए गए हैं, और मुझे प्रश्न पूछने का अवसर मिला है। मैं समझता/समझती हूँ कि मैं अपने चिकित्सा अभिलेख की प्रति माँग सकता/सकती हूँ और अस्पताल मेरी जानकारी गोपनीय रखेगा।",
};
