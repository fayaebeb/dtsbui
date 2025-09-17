import os
from typing import Optional, Tuple

from azure.storage.blob import BlobServiceClient


def _parse_account_key_from_connection(conn: str) -> Optional[str]:
    parts = {}
    for segment in conn.split(';'):
        if '=' not in segment:
            continue
        key, value = segment.split('=', 1)
        parts[key.strip()] = value.strip()
    return parts.get('AccountKey')


def get_storage_context(require_account_key: bool = False) -> Tuple[BlobServiceClient, str, str, Optional[str]]:
    """Return a blob service client plus (account, container, account_key).

    If require_account_key is True, ensure that an account key is present for SAS generation.
    """
    conn = os.getenv('AZURE_STORAGE_CONNECTION_STRING')
    account = os.getenv('AZURE_STORAGE_ACCOUNT')
    container = os.getenv('AZURE_STORAGE_CONTAINER')
    if not container:
        raise RuntimeError('AZURE_STORAGE_CONTAINER is not set')

    account_key = os.getenv('AZURE_STORAGE_KEY')

    if conn:
        bsc = BlobServiceClient.from_connection_string(conn)
        account = bsc.account_name
        if not account_key:
            account_key = _parse_account_key_from_connection(conn)
    else:
        if not account:
            raise RuntimeError('AZURE_STORAGE_ACCOUNT or AZURE_STORAGE_CONNECTION_STRING is required')
        if not account_key:
            raise RuntimeError('AZURE_STORAGE_KEY is required when using AZURE_STORAGE_ACCOUNT')
        bsc = BlobServiceClient(account_url=f'https://{account}.blob.core.windows.net/', credential=account_key)

    if require_account_key and not account_key:
        raise RuntimeError('Account key is required to generate SAS tokens. Set AZURE_STORAGE_KEY or include AccountKey in connection string.')

    return bsc, account, container, account_key
