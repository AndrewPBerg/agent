from shop.cart import price_after_discount


def test_discount_total():
    assert price_after_discount(100.0, 20.0) == 80.0
