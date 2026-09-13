// ============================================================
// utils/elo.js — حساب تصنيف ELO (ELO Rating System)
// ============================================================
const K = 32; // معامل التغيير القياسي (casual/online play)

const expectedScore = (ratingA, ratingB) => 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));

// scoreA: 1 = A فاز، 0 = A خسر، 0.5 = تعادل
const computeNewRatings = (ratingA, ratingB, scoreA) => {
  const expA = expectedScore(ratingA, ratingB);
  const expB = 1 - expA;
  const scoreB = 1 - scoreA;
  const newA = Math.round(ratingA + K * (scoreA - expA));
  const newB = Math.round(ratingB + K * (scoreB - expB));
  return [newA, newB];
};

module.exports = { computeNewRatings };
