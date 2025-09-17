import os
from typing import Optional, Tuple, cast

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
    """
    Return a blob service client plus (account, container, account_key).

    If require_account_key is True, ensure that an account key is present for SAS generation.
    """
    conn = os.getenv('AZURE_STORAGE_CONNECTION_STRING')

    container = os.getenv('AZURE_STORAGE_CONTAINER')
    if not container:
        raise RuntimeError('AZURE_STORAGE_CONTAINER is not set')

    account: Optional[str] = os.getenv('AZURE_STORAGE_ACCOUNT')
    account_key: Optional[str] = os.getenv('AZURE_STORAGE_KEY')

    if conn:
        bsc: BlobServiceClient = BlobServiceClient.from_connection_string(conn)
        # account_name is typed as Optional/Any in the SDK stubs; cast to str after validating
        acc_from_conn = cast(Optional[str], getattr(bsc, "account_name", None))
        if not acc_from_conn:
            raise RuntimeError("Could not resolve account name from connection string.")
        account = acc_from_conn
        if not account_key:
            account_key = _parse_account_key_from_connection(conn)
    else:
        if not account:
            raise RuntimeError('AZURE_STORAGE_ACCOUNT or AZURE_STORAGE_CONNECTION_STRING is required')
        if not account_key:
            raise RuntimeError('AZURE_STORAGE_KEY is required when using AZURE_STORAGE_ACCOUNT')
        bsc = BlobServiceClient(account_url=f'https://{account}.blob.core.windows.net/', credential=account_key)

    if require_account_key and not account_key:
        raise RuntimeError(
            'Account key is required to generate SAS tokens. '
            'Set AZURE_STORAGE_KEY or include AccountKey in the connection string.'
        )

    return bsc, account, container, account_key