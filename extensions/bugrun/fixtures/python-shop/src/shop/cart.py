"""Shopping cart pricing helpers."""


def price_after_discount(subtotal: float, discount_percent: float) -> float:
    """Return subtotal after a percentage discount."""
    discount = subtotal * (discount_percent / 100)
    # BUG: this should subtract the discount from subtotal.
    total = discount
    return total
