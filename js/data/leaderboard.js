// =============================================================================
// LEADERBOARD — seeded realistic competitors. Return % distributed to cluster
// around 4-8% over a 90-day window, with a right tail into ~22% and left into
// -10%. Enough variance that the player feels placed meaningfully.
// =============================================================================

// Mulberry32 seeded
function prng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = [
  "Aarav Sharma", "Ananya Gupta", "Arjun Mehta", "Aditi Patel", "Riya Kapoor",
  "Vihaan Singh", "Ishaan Reddy", "Myra Iyer", "Kiara Joshi", "Rudra Nair",
  "Sara Khan", "Advait Rao", "Zoya Ahmed", "Vivaan Chopra", "Aanya Bhatt",
  "Dhruv Malhotra", "Saanvi Verma", "Kabir Agarwal", "Pari Sethi", "Arnav Desai",
  "Tara Bose", "Reyansh Shah", "Nyra Menon", "Kian Pillai", "Avani Kulkarni",
  "Atharv Pandey", "Diya Banerjee", "Ayaan Srinivasan", "Mahira Jain", "Veer Goenka",
  "Aaradhya Das", "Yuvraj Rajput", "Ishita Chatterjee", "Rehan Mirza", "Anika Trivedi",
  "Shaurya Deshpande", "Nitya Mukherjee", "Rohan Saxena", "Meera Narayanan", "Kyra Oberoi",
  "Aarush Bhalla", "Siya Chandra", "Krishnav Sanyal", "Pranavi Madhavan", "Darsh Rastogi",
  "Ira Parekh", "Aryan Shastri", "Samaira Ghosh", "Arav Khanna", "Mahika Bhatia",
];

const SCHOOLS = [
  "DPS R.K. Puram", "Modern School", "Bombay Scottish", "St. Xavier's",
  "La Martiniere", "Sanskriti School", "Step by Step", "Vasant Valley",
  "Heritage School", "Welham Girls'", "Mayo College", "Cathedral & John Connon",
  "The Doon School", "Sardar Patel Vidyalaya", "Springdales", "DPS Noida",
  "Shiv Nadar School", "Greenwood High", "Jamnabai Narsee",
];

const CLASSES = ["Class 10A", "Class 10B", "Class 11 Science", "Class 11 Commerce", "Class 12 Science", "Class 12 Commerce"];

function oneOf(arr, rnd) {
  return arr[Math.floor(rnd() * arr.length)];
}

function gauss(rnd, mean, std) {
  // Box-Muller
  const u1 = Math.max(rnd(), 1e-9);
  const u2 = rnd();
  return mean + std * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function generateSeed() {
  const rnd = prng(20260418);   // event date seed
  const users = [];
  for (let i = 0; i < NAMES.length; i++) {
    const ret = gauss(rnd, 5.8, 6.2);
    const clamped = Math.max(-12, Math.min(28, ret));
    users.push({
      id: `u_${i + 1}`,
      name: NAMES[i],
      school: oneOf(SCHOOLS, rnd),
      class: oneOf(CLASSES, rnd),
      returnPct: Math.round(clamped * 10) / 10,   // one decimal
      trades: Math.floor(rnd() * 40 + 3),
      daysActive: Math.floor(rnd() * 45 + 15),
    });
  }
  // Sort desc by return
  users.sort((a, b) => b.returnPct - a.returnPct);
  return users;
}

export const LEADERBOARD = generateSeed();

/**
 * Insert the current user at their correct position given their return %.
 * Returns a copy with a { me: true } flag.
 */
export function leaderboardWithUser(userReturnPct, userName = "You", userSchool = "Your School") {
  const all = [...LEADERBOARD];
  const meEntry = {
    id: "me",
    name: userName,
    school: userSchool,
    class: "Your Class",
    returnPct: Math.round(userReturnPct * 10) / 10,
    trades: 0,
    daysActive: 1,
    me: true,
  };
  all.push(meEntry);
  all.sort((a, b) => b.returnPct - a.returnPct);
  // Annotate with ranks
  all.forEach((u, i) => { u.rank = i + 1; });
  return all;
}
