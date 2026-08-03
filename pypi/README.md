# PyPI xRegistry Wrapper

This service projects PyPI into xRegistry using the Python/PyPI extension model.

## Key routes

- `/`
- `/model`
- `/pythonregistries`
- `/pythonregistries/pypi`
- `/pythonregistries/pypi/packages`
- `/pythonregistries/pypi/packages/{packageid}`
- `/pythonregistries/pypi/packages/{packageid}/meta`
- `/pythonregistries/pypi/packages/{packageid}/versions`
- `/pythonregistries/pypi/packages/{packageid}/versions/{versionid}`
- `/pythonregistries/pypi/packages/{packageid}/doc`

## Notes

- `packageid` uses PyPI normalized project naming: lowercase with runs of `-`, `_`, and `.` collapsed to `-`.
- `versionid` transliterates PyPI local-version `+` to `~` per the extension spec.
- `name` preserves the published project name, and `version` preserves the published PEP 440 version string.
