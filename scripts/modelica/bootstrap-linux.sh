#!/usr/bin/env bash
# Ubuntu 24.04 amd64. 用法：bash scripts/modelica/bootstrap-linux.sh 安装目录 下载缓存目录
# 需要已安装的 GCC/G++、Clang、CMake、Make、curl、unzip，以及 Ubuntu main/universe 的 apt 索引。
# 安装限于指定的空目录。四个 OpenModelica 包约 19 MB、MSL 源归档约 18 MB。
# OMC 保留随包的 OSMC-PL/GPL 许可说明，MSL 的 BSD-3-Clause LICENSE 随库解包。
set -euo pipefail
export LC_ALL=C

if (( $# != 2 )); then
  echo 'Usage: bash bootstrap-linux.sh INSTALL_DIR DOWNLOAD_CACHE' >&2
  exit 2
fi
source /etc/os-release
if [[ "$ID" != ubuntu || "$VERSION_ID" != 24.04 || "$(dpkg --print-architecture)" != amd64 ]]; then
  echo 'This toolchain requires Ubuntu 24.04 amd64.' >&2
  exit 2
fi
for tool in gcc g++ cmake make curl dpkg-deb apt-cache sha256sum unzip tar flock; do
  command -v "$tool" >/dev/null || { echo "Missing prerequisite: $tool" >&2; exit 2; }
done
clang_path=$(command -v clang || command -v clang-18) || { echo 'Missing Clang' >&2; exit 2; }
clangxx_path=$(command -v clang++ || command -v clang++-18) || { echo 'Missing Clang++' >&2; exit 2; }
mkdir -p -- "$1"
prefix=$(cd -- "$1" && pwd -P)
stamp="$prefix/.gouyuan-openmodelica-toolchain"
version='OpenModelica 1.27.2 / MSL 4.0.0 / Ubuntu 24.04 amd64'
if [[ ! -f "$stamp" && -n "$(find "$prefix" -mindepth 1 -maxdepth 1 ! -name .bootstrap-lock -print -quit)" ]]; then
  echo "Choose an empty installation directory: $prefix" >&2
  exit 2
fi
exec 9>"$prefix/.bootstrap-lock"
flock 9
if [[ -f "$stamp" && "$(cat "$stamp")" != "$version" ]]; then
  echo "Installation directory belongs to another toolchain: $prefix" >&2
  exit 2
fi
printf '%s\n' "$version" > "$stamp"
mkdir -p -- "$2"
cache=$(cd -- "$2" && pwd -P)
if [[ -f "$prefix/.bootstrap-complete" && -f "$prefix/libraries/Modelica 4.0.0/package.mo" &&
      -x "$prefix/bin/omc" && "$("$prefix/bin/omc" --version)" = 'OpenModelica 1.27.2' ]]; then
  printf '%s\n' "$prefix/bin/omc"
  exit 0
fi

verify() { printf '%s  %s\n' "$1" "$2" | sha256sum --check --status; }
fetch() {
  local file="$1" url="$2" digest="$3" partial
  if [[ -f "$cache/$file" ]] && verify "$digest" "$cache/$file"; then return; fi
  partial=$(mktemp "$cache/.download.XXXXXXXX")
  if ! curl -fLsS --retry 2 --max-time 180 "$url" -o "$partial" || ! verify "$digest" "$partial"; then
    rm -f -- "$partial"
    echo "Failed to fetch or verify $file" >&2
    return 1
  fi
  mv -f -- "$partial" "$cache/$file"
}

# SHA-256 来自经 OpenModelica Build System 签名的 Noble release 包索引。
# 发布主密钥指纹 D229AF1CE5AED74E5F59DF303A59B53664970947。
release=https://build.openmodelica.org/apt/pool/contrib-noble
while read -r file digest; do
  fetch "$file" "$release/$file" "$digest"
  dpkg-deb -x "$cache/$file" "$prefix"
done <<'OMC_PACKAGES'
omc_1.27.2-1_amd64.deb 9412556112cf0b9deb320b1f4b1eaafe35583fbac0d0b9f07f8a427fbf9fac77
omc-common_1.27.2-1_all.deb 60fcc5440971973de268e5488f2c87f8651d4d1d87d494ae00f892cab6abd666
libomc_1.27.2-1_amd64.deb e865df120e960f716e12440104636980cfb5b4a24e112a1ab747551d3d5742d0
libomcsimulation_1.27.2-1_amd64.deb be399546f799e5239f9e6feac4739fcc2aa5df93d2ee75cafe2a1c0e049003d2
OMC_PACKAGES

# 使用已由 apt 验证的发行版索引，额外的动态库也只解到 prefix。
for dep in libblas3 libblas-dev liblapack3 liblapack-dev libgfortran5 libomniorb4-3t64 libomnithread4 zip; do
  candidate=$(apt-cache policy "$dep" | awk '/Candidate:/ {print $2}')
  if [[ -z "$candidate" || "$candidate" = '(none)' ]]; then
    echo "Missing Ubuntu main/universe package index for $dep; refresh it with apt-get update." >&2
    exit 2
  fi
  metadata=$(apt-cache show "$dep=$candidate")
  relative=$(awk '/^Filename: / {print $2; exit}' <<< "$metadata")
  digest=$(awk '/^SHA256: / {print $2; exit}' <<< "$metadata")
  [[ -n "$relative" && -n "$digest" ]] || { echo "Missing archive metadata for $dep=$candidate" >&2; exit 2; }
  file=${relative##*/}
  fetch "$file" "https://archive.ubuntu.com/ubuntu/$relative" "$digest"
  dpkg-deb -x "$cache/$file" "$prefix"
done

# 上游标签 v4.0.0 对应提交 6626538a236a34a390655b55d5e8c906bfe31772。
fetch MSL4.0.0.tgz https://codeload.github.com/modelica/ModelicaStandardLibrary/tar.gz/refs/tags/v4.0.0 \
  c5ebed218f20320b95aa5086c1c7de6a28bd1614e7bc14dc084523b5fa6a713c
mkdir -p "$prefix/bin" "$prefix/msl" "$prefix/libraries"
tar -xzf "$cache/MSL4.0.0.tgz" --strip-components=1 -C "$prefix/msl" \
  ModelicaStandardLibrary-4.0.0/{Modelica,ModelicaServices,Complex.mo,LICENSE}
ln -sfn "$prefix/msl/Modelica" "$prefix/libraries/Modelica 4.0.0"
ln -sfn "$prefix/msl/ModelicaServices" "$prefix/libraries/ModelicaServices 4.0.0"
ln -sfn "$prefix/msl/Complex.mo" "$prefix/libraries/Complex 4.0.0.mo"
ln -sfn "$(realpath -- "$clang_path")" "$prefix/bin/clang"
ln -sfn "$(realpath -- "$clangxx_path")" "$prefix/bin/clang++"
cat > "$prefix/env.sh" <<'ENV_FILE'
_om_prefix=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
export OPENMODELICAHOME="$_om_prefix/usr"
export OPENMODELICALIBRARY="$_om_prefix/libraries"
export MODELICAPATH="$OPENMODELICALIBRARY"
export PATH="$_om_prefix/bin:$OPENMODELICAHOME/bin:$PATH"
export LD_LIBRARY_PATH="$OPENMODELICAHOME/lib/x86_64-linux-gnu/omc:$OPENMODELICAHOME/lib/x86_64-linux-gnu:$OPENMODELICAHOME/lib/x86_64-linux-gnu/blas:$OPENMODELICAHOME/lib/x86_64-linux-gnu/lapack${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export LIBRARY_PATH="$LD_LIBRARY_PATH${LIBRARY_PATH:+:$LIBRARY_PATH}"
unset _om_prefix
ENV_FILE
cat > "$prefix/bin/omc" <<'OMC_WRAPPER'
#!/usr/bin/env bash
source "$(dirname -- "$0")/../env.sh"
exec "$OPENMODELICAHOME/bin/omc" "$@"
OMC_WRAPPER
chmod +x "$prefix/bin/omc"
actual=$("$prefix/bin/omc" --version)
[[ "$actual" = 'OpenModelica 1.27.2' ]] || { echo "Unexpected compiler: $actual" >&2; exit 3; }
touch "$prefix/.bootstrap-complete"
printf '%s\n' "$prefix/bin/omc"
