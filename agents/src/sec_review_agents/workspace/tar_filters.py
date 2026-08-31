import tarfile


def workspace_tar_filter(
    member: tarfile.TarInfo,
    destination: str,
) -> tarfile.TarInfo | None:
    """Filter workspace archive entries while tolerating fixture symlinks."""
    # Workspaces can contain upstream repository test fixtures. Some projects
    # intentionally include invalid symlinks, including absolute symlink targets,
    # to test their own filesystem behavior. Python's data filter rejects those
    # links even though creating the symlink does not read or write the target.
    #
    # Keep data-filter protection for regular files, directories, hard links,
    # and special files. For symlink entries only, use tar_filter so the archive
    # member path still cannot escape the destination while preserving the
    # symlink target exactly as it exists in the source workspace. Bounded
    # workspace reads do not follow symlinks.
    if member.issym():
        filtered = tarfile.tar_filter(member, destination)
        if filtered is None:
            return None
        # tarfile extraction filters use None to clear ownership metadata.
        return filtered.replace(
            uid=None,  # type: ignore[arg-type]
            gid=None,  # type: ignore[arg-type]
            uname=None,  # type: ignore[arg-type]
            gname=None,  # type: ignore[arg-type]
            deep=False,
        )
    return tarfile.data_filter(member, destination)
