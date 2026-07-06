"""Generate a CPF with valid check digits (format-valid, not real)."""
import random

def calc_digit(base, weights):
    s = sum(int(d) * w for d, w in zip(base, weights))
    r = s % 11
    return '0' if r < 2 else str(11 - r)

# 9 random digits
base = ''.join(str(random.randint(0, 9)) for _ in range(9))
d1 = calc_digit(base, range(10, 1, -1))
d2 = calc_digit(base + d1, range(11, 1, -1))
cpf = base + d1 + d2
print(cpf)
