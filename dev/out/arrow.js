x => {
  console.log(x);
};

async y => {
  console.log(y);
};

x => x * 2;

() => 42;

f(() => 42);
f(() => {
  42;
});
f(x, () => 42);

() => 42;

x => x;

(x, y) => x + y;

(x, y, z) => x + y + z;

x => {
  x();
};

(x, y, z) => {
  x + y + z;
};

const f = (x, y = 2) => x * y;

g(a, (b, c) => b - c);

const g = (a, b = (x, y) => x + y) => b(2, a);

const h = (a, b = (x, y) => x + y) => b(2, a);

const i = (a, b = (x, y) => x + y) => b(2, a);

