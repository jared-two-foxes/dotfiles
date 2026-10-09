import unittest
from greeting import greet


class GreetingTests(unittest.TestCase):
    def test_plain_name(self):
        self.assertEqual(greet("Ada"), "Hello, Ada")

    def test_space_padding(self):
        self.assertEqual(greet(" Ada "), "Hello, Ada")


if __name__ == "__main__":
    unittest.main()
