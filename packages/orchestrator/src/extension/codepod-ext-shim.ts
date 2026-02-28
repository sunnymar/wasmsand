/**
 * Python source for /usr/lib/python/codepod_ext.py — bridge to host
 * extensions via the _codepod native module.
 */
export const CODEPOD_EXT_SOURCE = `\
"""codepod_ext -- bridge to host extensions via _codepod native module."""
import _codepod

def call(extension_name, method, **kwargs):
    """Call a host extension method. Returns the result."""
    return _codepod.extension_call(extension_name, method, **kwargs)

def is_extension(name):
    """Check if a named extension is available."""
    return _codepod.is_extension(name)
`;
