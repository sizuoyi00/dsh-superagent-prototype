export function applyDiscount(amount, discountPercent) {
  if (typeof amount !== 'number' || amount < 0) {
    throw new RangeError('amount must be a non-negative number');
  }

  if (
    typeof discountPercent !== 'number' ||
    discountPercent < 0 ||
    discountPercent >= 100
  ) {
    throw new RangeError('discountPercent must be between 0 and 100');
  }

  const discountedAmount = amount * (1 - discountPercent / 100);
  return Math.round((discountedAmount + Number.EPSILON) * 100) / 100;
}
