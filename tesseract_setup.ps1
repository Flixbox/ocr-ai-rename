# Define paths
$tessApp = "$env:USERPROFILE\scoop\apps\tesseract\current\tessdata"
$tessLangs = "$env:USERPROFILE\scoop\apps\tesseract-languages\current"

# Force copy 'configs'
Copy-Item -Path "$env:USERPROFILE\scoop\apps\tesseract\current\tessdata\configs" -Destination "$env:USERPROFILE\scoop\apps\tesseract-languages\current\" -Recurse -Force

# Force copy 'tessconfigs'
Copy-Item -Path "$env:USERPROFILE\scoop\apps\tesseract\current\tessdata\tessconfigs" -Destination "$env:USERPROFILE\scoop\apps\tesseract-languages\current\" -Recurse -Force

# Remove potentially broken/empty folders in the languages directory
Remove-Item -Path "$tessLangs\configs", "$tessLangs\tessconfigs" -Recurse -ErrorAction SilentlyContinue

# Copy the actual config files from the main Tesseract app to the languages folder
Copy-Item -Path "$tessApp\configs" -Destination "$tessLangs\" -Recurse -Force
Copy-Item -Path "$tessApp\tessconfigs" -Destination "$tessLangs\" -Recurse -Force

# Verify the hocr file is now reachable
Test-Path "$tessLangs\configs\hocr"