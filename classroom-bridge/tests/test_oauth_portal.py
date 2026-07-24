import os
import unittest
from unittest.mock import patch

from oauth_portal import account_is_allowed, masked_account_hint


class OAuthPortalAccountTests(unittest.TestCase):
    def test_exact_school_email_is_required_when_configured(self):
        environment = {
            "ALLOWED_GOOGLE_EMAIL": "alumno@escuela.edu.mx",
            "ALLOWED_GOOGLE_DOMAIN": "",
        }
        with patch.dict(os.environ, environment, clear=False):
            self.assertTrue(account_is_allowed("ALUMNO@ESCUELA.EDU.MX"))
            self.assertFalse(account_is_allowed("alumno@gmail.com"))
            self.assertFalse(account_is_allowed("otro@escuela.edu.mx"))

    def test_domain_fallback_rejects_personal_accounts(self):
        environment = {
            "ALLOWED_GOOGLE_EMAIL": "",
            "ALLOWED_GOOGLE_DOMAIN": "escuela.edu.mx",
        }
        with patch.dict(os.environ, environment, clear=False):
            self.assertTrue(account_is_allowed("alumno@escuela.edu.mx"))
            self.assertFalse(account_is_allowed("alumno@gmail.com"))

    def test_account_hint_masks_local_part(self):
        environment = {
            "ALLOWED_GOOGLE_EMAIL": "juan.carlos@escuela.edu.mx",
            "ALLOWED_GOOGLE_DOMAIN": "",
        }
        with patch.dict(os.environ, environment, clear=False):
            self.assertEqual(masked_account_hint(), "ju…@escuela.edu.mx")


if __name__ == "__main__":
    unittest.main()
