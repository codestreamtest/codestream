Set-StrictMode -Version Latest

New-Module -ScriptBlock {

    function Get-AssemblyInfoPath([System.string]$project) {
        if($project -eq $null){
            throw "missing project"
        }
        Join-Path $rootDirectory src\$project\Properties\AssemblyInfo.cs
    }

    function Read-VersionAssemblyInfo([System.string]$project) {
        $file = Get-AssemblyInfoPath $project
        $currentVersion = Get-Content $file | %{
        $regex = '\[assembly: AssemblyVersion\("(\d+\.\d+\.\d+.\d+)"\)]'
            if ($_ -match $regex) {
                $matches[1]
            }
        }
        [System.Version] $currentVersion
    }

    function Write-AssemblyInfo([System.Version]$version, [System.string]$project) {
        $file = Get-AssemblyInfoPath $project
        $numberOfReplacements = 0
        $newContent = Get-Content $file | %{
            $newString = $_
            #$regex = "(string Version = `")\d+\.\d+\.\d+\.\d+"
            $regex = "\(`"(\d+\.\d+\.\d+.\d+)`"\)"
            if ($_ -match $regex) {
                $numberOfReplacements++
                $newString = $newString -replace $regex,  "(`"$($version.Major).$($version.Minor).$(($version.Build, 0 -ne $null)[0]).$(($version.Revision, 0 -ne $null)[0])`")"
            }
            $newString
        }

        if ($numberOfReplacements -ne 2) {
            Die 1 "Expected to replace the version number in 1 place in AssemblyInfo.cs (Version) but actually replaced it in $numberOfReplacements"
        }
    #     Write-Host $version
    #     # ($version.Patch, 0 -ne $null)[0]
    #     Write-Host "$($version.Major).$($version.Minor).$(($version.Patch, 0 -ne $null)[0])"
    # throw $file
        $newContent | Set-Content $file
    }

    Export-ModuleMember -Function Get-AssemblyInfoPath,Read-VersionAssemblyInfo,Write-AssemblyInfo
}