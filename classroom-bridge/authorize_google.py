from __future__ import annotations

import argparse
import base64
from pathlib import Path

from google_auth_oauthlib.flow import InstalledAppFlow

from classroom_bridge import SCOPES


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Autoriza Google Classroom y genera el secreto para GitHub Actions."
    )
    parser.add_argument(
        "--credentials",
        default="credentials.json",
        help="Ruta al OAuth client JSON descargado de Google Cloud.",
    )
    parser.add_argument(
        "--output",
        default="google_token.b64",
        help="Archivo local donde se guardará temporalmente el valor base64.",
    )
    args = parser.parse_args()

    credentials_path = Path(args.credentials)
    if not credentials_path.exists():
        raise SystemExit(
            f"No existe {credentials_path}. Descarga el cliente OAuth de tipo Desktop app "
            "desde Google Cloud y guárdalo con ese nombre."
        )

    flow = InstalledAppFlow.from_client_secrets_file(str(credentials_path), SCOPES)
    credentials = flow.run_local_server(
        port=0,
        access_type="offline",
        prompt="consent",
        include_granted_scopes="true",
    )
    encoded = base64.b64encode(credentials.to_json().encode("utf-8")).decode("ascii")
    output_path = Path(args.output)
    output_path.write_text(encoded, encoding="utf-8")

    print(f"Se creó {output_path}.")
    print("Copia su contenido al secret GOOGLE_TOKEN_JSON_B64 del repositorio.")
    print("Después elimina el archivo local; contiene acceso sensible a tu cuenta.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
