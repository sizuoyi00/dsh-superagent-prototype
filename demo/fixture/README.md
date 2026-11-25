# Discount boundary fixture

`applyDiscount(amount, discountPercent)` accepts a non-negative numeric amount
and a discount percentage from 0 through 100. It returns the discounted amount
rounded to two decimal places; a 100% discount returns `0`.

Run the dependency-free test suite with:

```sh
node --test
```

The initial fixture deliberately lacks regression coverage for the 100%
boundary. The demo worker adds that coverage before correcting the behavior.
