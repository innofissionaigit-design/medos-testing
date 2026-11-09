/** Synthetic reference lists for the demo seed. No real people, addresses or phone numbers. */

export const FIRST_NAMES_F = ["Ananya", "Priya", "Sneha", "Riya", "Madhumita", "Sutapa", "Debjani", "Tanushree", "Mousumi", "Anjali", "Kavita", "Pooja", "Rima", "Shreya", "Nandini", "Swati", "Arpita", "Jhuma", "Moumita", "Rekha"] as const;
export const FIRST_NAMES_M = ["Arjun", "Rahul", "Subhajit", "Soumen", "Debashis", "Amit", "Sandip", "Biswajit", "Partha", "Tapan", "Rajesh", "Sourav", "Anirban", "Kaushik", "Dipankar", "Manoj", "Prasenjit", "Gautam", "Ritwik", "Abhijit"] as const;
export const LAST_NAMES = ["Banerjee", "Chatterjee", "Mukherjee", "Ghosh", "Das", "Sen", "Roy", "Dutta", "Bose", "Sarkar", "Mondal", "Paul", "Saha", "Biswas", "Majumdar", "Halder", "Pal", "Dey", "Chakraborty", "Mitra"] as const;

export const LOCALITIES = [
  { street: "Synthetic Lane, Salt Lake", district: "North 24 Parganas", pin: "700091" },
  { street: "Sample Road, Behala", district: "Kolkata", pin: "700034" },
  { street: "Example Street, Howrah", district: "Howrah", pin: "711101" },
  { street: "Demo Avenue, Dum Dum", district: "North 24 Parganas", pin: "700028" },
  { street: "Test Path, Jadavpur", district: "Kolkata", pin: "700032" },
  { street: "Model Sarani, Barasat", district: "North 24 Parganas", pin: "700124" },
] as const;

/** 25 generics × 4 strengths = exactly 100 medicine masters. */
export const GENERICS = [
  { name: "Paracetamol", form: "TABLET", strengths: ["250 mg", "500 mg", "650 mg", "1 g"] },
  { name: "Amoxicillin", form: "CAPSULE", strengths: ["250 mg", "500 mg", "875 mg", "1 g"] },
  { name: "Azithromycin", form: "TABLET", strengths: ["250 mg", "500 mg", "200 mg", "100 mg"] },
  { name: "Cefixime", form: "TABLET", strengths: ["100 mg", "200 mg", "400 mg", "50 mg"] },
  { name: "Ciprofloxacin", form: "TABLET", strengths: ["250 mg", "500 mg", "750 mg", "100 mg"] },
  { name: "Metformin", form: "TABLET", strengths: ["250 mg", "500 mg", "850 mg", "1 g"] },
  { name: "Amlodipine", form: "TABLET", strengths: ["2.5 mg", "5 mg", "10 mg", "1 mg"] },
  { name: "Atorvastatin", form: "TABLET", strengths: ["10 mg", "20 mg", "40 mg", "80 mg"] },
  { name: "Omeprazole", form: "CAPSULE", strengths: ["10 mg", "20 mg", "40 mg", "30 mg"] },
  { name: "Pantoprazole", form: "TABLET", strengths: ["20 mg", "40 mg", "80 mg", "10 mg"] },
  { name: "Ondansetron", form: "TABLET", strengths: ["2 mg", "4 mg", "8 mg", "16 mg"] },
  { name: "Cetirizine", form: "TABLET", strengths: ["5 mg", "10 mg", "20 mg", "2.5 mg"] },
  { name: "Levocetirizine", form: "TABLET", strengths: ["2.5 mg", "5 mg", "10 mg", "1.25 mg"] },
  { name: "Ibuprofen", form: "TABLET", strengths: ["200 mg", "400 mg", "600 mg", "800 mg"] },
  { name: "Diclofenac", form: "TABLET", strengths: ["25 mg", "50 mg", "75 mg", "100 mg"] },
  { name: "Losartan", form: "TABLET", strengths: ["12.5 mg", "25 mg", "50 mg", "100 mg"] },
  { name: "Telmisartan", form: "TABLET", strengths: ["20 mg", "40 mg", "80 mg", "10 mg"] },
  { name: "Glimepiride", form: "TABLET", strengths: ["1 mg", "2 mg", "3 mg", "4 mg"] },
  { name: "Salbutamol", form: "TABLET", strengths: ["2 mg", "4 mg", "8 mg", "1 mg"] },
  { name: "Montelukast", form: "TABLET", strengths: ["4 mg", "5 mg", "10 mg", "20 mg"] },
  { name: "Doxycycline", form: "CAPSULE", strengths: ["50 mg", "100 mg", "200 mg", "20 mg"] },
  { name: "Metronidazole", form: "TABLET", strengths: ["200 mg", "400 mg", "500 mg", "250 mg"] },
  { name: "Ranitidine", form: "TABLET", strengths: ["75 mg", "150 mg", "300 mg", "50 mg"] },
  { name: "Folic acid", form: "TABLET", strengths: ["1 mg", "5 mg", "400 mcg", "2 mg"] },
  { name: "Vitamin D3", form: "CAPSULE", strengths: ["1000 IU", "2000 IU", "60000 IU", "400 IU"] },
] as const;
