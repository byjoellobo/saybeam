/**
 * Field-test bench data: reading passages and stored results.
 *
 * Passages are original texts written for this project. They mix classroom
 * Indian English, romanised Hindi-English code-mixing, Devanagari Hindi and
 * names and numbers, the cases the risk plan says were never measured.
 */
export interface Passage {
  readonly id: string;
  readonly label: string;
  readonly lang: string;
  readonly text: string;
  readonly note?: string;
}

export const PASSAGES: readonly Passage[] = [
  {
    id: 'classroom-en-in',
    label: 'Classroom, Indian English',
    lang: 'en-IN',
    text: "Good morning, everyone. Today we will continue with chapter four, the structure of the atom. Before we start, please take out your notebooks. Rutherford's gold foil experiment showed that most of the atom is empty space. The nucleus is very small but it carries almost all of the mass. Priya, can you tell us the charge on an electron? Very good. For homework, solve questions twelve to eighteen from the textbook and submit them by Thursday.",
  },
  {
    id: 'hinglish',
    label: 'Code-mixed Hindi and English (romanised)',
    lang: 'en-IN',
    text: 'Chaliye, aaj ka topic hai photosynthesis. Plants apna khana khud banate hain, using sunlight, water aur carbon dioxide. Ye process mainly leaves mein hota hai, kyunki wahan chlorophyll hota hai. Agar koi doubt hai toh abhi pooch lo, baad mein time nahi milega. Next class mein hum respiration discuss karenge, so please chapter padh ke aana.',
    note: 'Romanised Hindi has no fixed spelling. Add equivalences (for example "nahin = nahi") so spelling variants are not counted as errors.',
  },
  {
    id: 'names-numbers',
    label: 'Names, places and numbers',
    lang: 'en-IN',
    text: 'The parent teacher meeting is on the twenty third of March at half past ten in room two hundred and four. Please contact Doctor Venkataraman or Mrs Fernandes before Friday. The annual fee is two thousand five hundred rupees, payable at the office in Thiruvananthapuram or online.',
    note: 'Numbers are written as words. Engines that output digits will score worse here; that is expected and worth knowing.',
  },
  {
    id: 'worship',
    label: 'Place of worship announcement',
    lang: 'en-IN',
    text: 'Welcome to our Sunday gathering. Please keep your phones on silent. The choir will now lead us in the opening hymn, after which Father Joseph will share the readings for today. Tea and snacks will be served in the hall after the service. Everyone is welcome to stay.',
  },
  {
    id: 'hindi',
    label: 'Hindi (Devanagari)',
    lang: 'hi-IN',
    text: 'नमस्ते दोस्तों, आज हम पानी के चक्र के बारे में पढ़ेंगे। सूरज की गर्मी से पानी भाप बनकर ऊपर जाता है और ठंडा होकर बादल बनते हैं। फिर वही पानी बारिश बनकर धरती पर वापस आता है।',
    note: 'Needs a multilingual engine: Whisper Base or Small, browser speech with hi-IN, or WhisperLive.',
  },
];

export interface BenchResult {
  readonly id: string;
  readonly at: string;
  readonly deviceLabel: string;
  readonly speakerLabel: string;
  readonly engine: string;
  readonly backend: string;
  readonly mode: 'live' | 'file';
  readonly passage: string;
  readonly audioSec: number | null;
  readonly asrSec: number | null;
  readonly rtf: number | null;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly loadMs: number | null;
  readonly wer: number | null;
  readonly cer: number | null;
  readonly refWords: number | null;
  readonly hypothesis: string;
  readonly cores: number;
  readonly memoryGb: number | null;
  readonly gpu: string | null;
  readonly userAgent: string;
}

const KEY = 'saybeam:bench-results';

export function loadResults(): BenchResult[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as BenchResult[]).filter((r) => r && typeof r.id === 'string') : [];
  } catch {
    return [];
  }
}

export function storeResults(results: readonly BenchResult[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(results.slice(-500)));
  } catch {
    // ignore quota errors
  }
}

export function percentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? null;
}

const CSV_COLUMNS: ReadonlyArray<keyof BenchResult> = [
  'at',
  'deviceLabel',
  'speakerLabel',
  'engine',
  'backend',
  'mode',
  'passage',
  'audioSec',
  'asrSec',
  'rtf',
  'p50Ms',
  'p95Ms',
  'loadMs',
  'wer',
  'cer',
  'refWords',
  'cores',
  'memoryGb',
  'gpu',
  'userAgent',
  'hypothesis',
];

export function toCsv(results: readonly BenchResult[]): string {
  const cell = (v: unknown): string => {
    let s = v === null || v === undefined ? '' : String(v);
    // Spreadsheets run cells starting with = + - @ as formulas: neutralise text cells.
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [CSV_COLUMNS.join(','), ...results.map((r) => CSV_COLUMNS.map((c) => cell(r[c])).join(','))].join('\n').concat('\n');
}
