// The date in a timezone, written the way a date is stored.
export const dateIn = (timeZone: string) => new Intl.DateTimeFormat("en-CA", { timeZone }).format();

// The two timezones furthest from UTC, 14 hours ahead and 12 behind. At any moment the date in
// at least one of them is not the date in UTC.
const AHEAD = "Pacific/Kiritimati";
const BEHIND = "Etc/GMT+12";

// A timezone where it is another date than in UTC right now.
export const timeZoneOnAnotherDate = () => (dateIn(AHEAD) === dateIn("UTC") ? BEHIND : AHEAD);
