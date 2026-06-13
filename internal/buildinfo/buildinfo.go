package buildinfo

const version = "dev"

func VersionString(name string) string {
	return name + " " + version
}
