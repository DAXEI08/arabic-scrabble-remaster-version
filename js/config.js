// Static game data and constants. No logic, no DOM, no imports.

export const SIZE = 15, RACK = 7, BINGO = 50, MIN_BAG_SWAP = 7, MAX_IDLE = 4, CENTER = 7, PENALTY = 5;
export const DURATIONS = [10, 15, 25, 40, 60];
export const DEFAULT_MINUTES = 25;
export const JUDGES_KEY = 'scrabble.judges';
export const TOAST_MS = 4000, TICK_MS = 250;

// [letter, value, count]; empty letter = blank
export const TILES = [['ا',1,8],['ل',1,8],['ي',1,6],['ت',1,4],['ن',1,4],['ر',1,4],['و',2,6],['م',2,4],['ب',2,4],['د',2,4],['ه',2,4],
['س',3,4],['ج',3,2],['ح',3,2],['ك',3,2],['خ',4,2],['ق',4,2],['ف',4,2],['ث',5,1],['ذ',5,1],['ش',5,1],['ض',5,1],
['ط',8,1],['ظ',8,1],['ع',8,1],['ص',10,1],['ز',10,1],['غ',10,1],
['أ',2,4],['ة',3,3],['ى',3,2],['إ',3,2],['ء',4,2],['ئ',4,2],['ؤ',5,1],['آ',5,1],['',0,2]];

// Blank-tile picker, dictionary order
export const ALPHA = 'ءآأؤإئابةتثجحخدذرزسشصضطظعغفقكلمنهوىي';

// Premium squares: 1 DL, 2 TL, 3 DW, 4 TW, 5 center (DW)
const HALF = ['400100040001004','030002000200030','003000101000300','100300010003001','000030000030000','020002000200020','001000101000100','400100050001004'];
export const LAYOUT = [...HALF, ...HALF.slice(0, 7).reverse()].map(s => [...s].map(Number));

// Per-letter [x,y] offset in em so every glyph's ink is centred in the tile, above the value digit
export const GLYPH = {ء:[0.00,-0.26],آ:[0.03,0.06],أ:[-0.00,0.10],ؤ:[0.07,-0.19],إ:[-0.04,-0.18],ئ:[-0.01,-0.21],ا:[0.00,-0.04],ب:[0.01,-0.34],ة:[-0.00,-0.11],ت:[0.01,-0.16],ث:[0.01,-0.11],ج:[-0.07,-0.54],ح:[-0.07,-0.54],خ:[-0.07,-0.43],د:[0.01,-0.21],ذ:[0.01,-0.09],ر:[0.06,-0.38],ز:[0.06,-0.23],س:[-0.00,-0.33],ش:[-0.00,-0.16],ص:[-0.00,-0.33],ض:[-0.00,-0.23],ط:[0.01,-0.05],ظ:[0.01,-0.05],ع:[-0.11,-0.40],غ:[-0.11,-0.32],ف:[-0.01,-0.05],ق:[0.01,-0.18],ك:[0.01,0.01],ل:[-0.01,-0.05],م:[0.01,-0.45],ن:[-0.01,-0.14],و:[0.07,-0.37],ى:[-0.01,-0.30],ي:[-0.01,-0.42],ه:[0.04,-0.21]};

// Letter shown on tiles / blank picker; game logic still uses plain ه
export const FACE = {'ه':'هـ'};

// Full text everywhere; the centre star is a word x2
export const LABEL = {1:'x2 حرف',2:'x3 حرف',3:'x2 كلمة',4:'x3 كلمة',5:'x2 كلمة'};

export const NAMES = ['اللاعب الأول', 'اللاعب الثاني'];
export const REASONS = {time:'انتهى وقت أحد اللاعبين', rack:'أنهى أحد اللاعبين جميع قطعه', idle:'تتابع التمرير/التبديل دون تسجيل نقاط'};
