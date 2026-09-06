// Time flow - pure time functions, zero IO, zero privacy collection (v1 port).
// Produces weekday / daypart / festival context for the reflection digest.

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

// Fixed Gregorian memorial days (lunar festivals pending, as in v1).
const FESTIVALS: Record<string, string> = {
  '01-01': '元旦',
  '02-14': '情人节',
  '03-08': '妇女节',
  '04-01': '愚人节',
  '05-01': '劳动节',
  '05-04': '青年节',
  '06-01': '儿童节',
  '09-10': '教师节',
  '10-01': '国庆节',
  '10-24': '程序员节',
  '12-24': '平安夜',
  '12-25': '圣诞节',
};

function daypart(h: number): string {
  if (h < 6) return '深夜';
  if (h < 9) return '清晨';
  if (h < 12) return '上午';
  if (h < 14) return '正午';
  if (h < 18) return '午后';
  if (h < 22) return '夜晚';
  return '夜里';
}

export interface TimeContext {
  weekday: string;
  isWeekend: boolean;
  daypart: string;
  festival: string | null;
  dateKey: string;
}

export function timeContext(now: Date = new Date()): TimeContext {
  const weekday = WEEKDAYS[now.getDay()]!;
  const isWeekend = now.getDay() === 0 || now.getDay() === 6;
  const part = daypart(now.getHours());
  const key = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const festival = FESTIVALS[key] ?? null;
  return { weekday, isWeekend, daypart: part, festival, dateKey: key };
}
