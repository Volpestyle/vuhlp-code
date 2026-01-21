
expo	54.0.13	54.0.31  ￼	Same SDK (54) but not latest patch. Safe to bump within SDK 54.

react	19.1.0	19.2.3  ￼	Expo SDK 54 is tied to React 19.1.0 (per SDK 54 beta notes).  ￼

react-native	0.81.4	0.83.1  ￼	Expo SDK 54 ships with RN 0.81.  ￼

@shopify/react-native-skia	2.2.12	2.4.14  ￼	Expo Go “bundles” Skia 2.2.12 for SDK 54; upgrading beyond that usually means using a dev build.  ￼

With Expo managed workflow, you don’t typically pick React Native (and often React) independently — they’re coupled to the Expo SDK you’re on. Expo SDK 54 includes RN 0.81  ￼, and Expo SDK 55 is the one expected to bring RN 0.83.  ￼

Also: Expo Go only supports the current/latest SDK, so once SDK 55 becomes “current”, SDK 54 projects may need upgrading (or you switch to dev builds).  ￼

If you just want the “latest within SDK 54”

Update Expo from ~54.0.13 → ~54.0.31 (latest patch).  ￼
I made you an updated zip with that single patch bump:

(React/RN/Skia stay as-is to remain aligned with SDK 54 / Expo Go.)

⸻

If we integrate “React Three” into this Expo app, what latest version should we use?

Recommended “latest” set (compatible with React 19)
	•	@react-three/fiber: 9.5.0  ￼
	•	three: 0.182.0  ￼
	•	Optional helpers: @react-three/drei: 10.7.7  ￼

R3F’s docs explicitly say:
	•	It works with React Native and is compatible with React 18 & 19
	•	@react-three/fiber@9 pairs with React 19  ￼

Expo-specific pieces you’ll add

React Three Fiber on React Native uses Expo’s GL bindings:

npx expo install expo-gl
npm install three @react-three/fiber
# optional:
npm install @react-three/drei

That matches R3F’s RN instructions (import from @react-three/fiber/native, uses expo-gl under the hood, etc.).  ￼

Important practical notes
	•	Use the native entrypoints:
	•	@react-three/fiber/native
	•	@react-three/drei/native  ￼
	•	If you load .glb/.gltf or textures, you may need to add asset extensions to Metro (R3F docs show an example).  ￼
	•	iOS simulator OpenGL can be flaky; R3F recommends testing on a physical iOS device for stability.  ￼

If you tell me whether you want to keep this Expo Go compatible or you’re fine moving to a dev build, I can point you to the cleanest setup path for Skia + R3F together (they can coexist, but you’ll want to be intentional about view layering and gestures).